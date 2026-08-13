import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"
import { requireBakerUser } from "../../../../services/baker-portal/guard"
import {
  updateBakerProduct,
  deleteBakerProduct,
  type UpdateBakerProductInput,
} from "../../../../services/baker-portal/products"

/**
 * PATCH  /baker/products/:id — change a listing
 * DELETE /baker/products/:id — remove one permanently
 *
 * Until these existed a baker could only ever create. A wrong price, a bad photo or a typo in a
 * description had no fix short of archiving the listing and starting again — and archiving is
 * terminal for a baker, so that was a one-way door. It also made every data mistake an ops problem,
 * which is the wrong place for it: the person who knows the price is wrong is the baker.
 *
 * Ownership is resolved from the SESSION inside the service's transaction, never from this URL. The
 * :id may name any product in the database and still only works if this baker owns it; anything else
 * is a 404 rather than a 403, so the endpoint cannot be used to discover which ids exist.
 */

/** Absent means "leave it alone"; present-and-empty means "clear it". Undefined is not null here. */
function optionalStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

/**
 * GET /baker/products/:id — one listing, in the shape the edit form needs.
 *
 * The list endpoint deliberately returns only what a card renders. An edit form needs everything the
 * create form collects — description, every photo in order, every size and price, the metadata
 * fields — so it gets its own query rather than bloating the list for all 200 rows.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  const productId = String(req.params.id || "")

  try {
    const db = getBakerNetworkDbPool()

    // Scoped by the session's baker_id in the WHERE clause, so ownership is a property of the query
    // rather than a check that could be forgotten. A product owned by someone else simply is not
    // found.
    const result = await db.query(
      `SELECT bp.publication_state,
              p.id, p.title, p.description, p.thumbnail, p.metadata, p.type_id,
              pt.value AS type_value,
              (SELECT pcp.product_category_id
                 FROM public.product_category_product pcp
                WHERE pcp.product_id = p.id LIMIT 1) AS category_id,
              COALESCE((
                SELECT json_agg(i.url ORDER BY pi.image_id)
                  FROM public.product_images pi
                  JOIN public.image i ON i.id = pi.image_id AND i.deleted_at IS NULL
                 WHERE pi.product_id = p.id
              ), '[]'::json) AS image_urls,
              -- price_list_id IS NULL matters: money_amount also holds sale and price-list rows, and
              -- prefilling an edit form with a promotional price would let a baker save it as the
              -- base price without ever knowing they had.
              COALESCE((
                SELECT json_agg(json_build_object('label', v.title, 'price', ma.amount / 100.0)
                                ORDER BY v.variant_rank)
                  FROM public.product_variant v
                  LEFT JOIN public.product_variant_money_amount pvma
                         ON pvma.variant_id = v.id AND pvma.deleted_at IS NULL
                  LEFT JOIN public.money_amount ma
                         ON ma.id = pvma.money_amount_id
                        AND ma.currency_code = 'inr'
                        AND ma.price_list_id IS NULL
                        AND ma.deleted_at IS NULL
                 WHERE v.product_id = p.id
              ), '[]'::json) AS sizes
         FROM baker_network.baker_products bp
         JOIN public.product p ON p.id = bp.medusa_product_id
         LEFT JOIN public.product_type pt ON pt.id = p.type_id
        WHERE bp.baker_id = $1 AND bp.medusa_product_id = $2`,
      [ctx.bakerId, productId]
    )

    const row = result.rows[0]
    if (!row) {
      return res.status(404).json({ error: "We couldn't find that product." })
    }

    const meta = (row.metadata ?? {}) as Record<string, unknown>

    return res.status(200).json({
      product: {
        id: row.id,
        title: row.title,
        description: row.description,
        categoryId: row.category_id,
        typeValue: row.type_value,
        // Thumbnail first: it is the main image, and the form's ordering is what decides which
        // photo becomes the thumbnail on save. Losing that order would silently reshuffle it.
        imageUrls: orderThumbnailFirst(row.image_urls as string[], row.thumbnail),
        sizes: row.sizes,
        state: row.publication_state,
        prepHours: meta.prep_hours ?? null,
        contains: meta.contains ?? [],
        whoIsItFor: meta.who_is_it_for ?? [],
        highlights: meta.highlights ?? [],
        careNote: meta.care_note ?? null,
      },
    })
  } catch (error) {
    console.error("[API /baker/products/:id GET] Error:", error)
    return res.status(500).json({ error: "Couldn't load this product. Please try again." })
  }
}

/**
 * Medusa's product_images join carries no explicit ordering column, so the gallery comes back in
 * whatever order the join yields. The one piece of order that IS meaningful is which photo is the
 * thumbnail, and that is recoverable — so it is restored to the front and the rest follow.
 */
function orderThumbnailFirst(urls: string[], thumbnail: string | null): string[] {
  const list = (urls ?? []).filter(Boolean)
  if (!thumbnail) return list
  return [thumbnail, ...list.filter((u) => u !== thumbnail)]
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  const productId = String(req.params.id || "")
  if (!productId) {
    return res.status(400).json({ error: "Product id is required." })
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>

    const db = getBakerNetworkDbPool()
    const bakerRow = await db.query(`SELECT slug, city FROM baker_network.bakers WHERE id = $1`, [
      ctx.bakerId,
    ])

    // Read field by field rather than spread, for the same reason create does: the request body must
    // never be the shape of what gets stored.
    const patch: UpdateBakerProductInput = {
      name: body.name !== undefined ? String(body.name) : undefined,
      description: body.description !== undefined ? String(body.description) : undefined,
      categoryId: body.categoryId !== undefined ? String(body.categoryId) : undefined,
      typeValue: body.typeValue !== undefined ? String(body.typeValue) : undefined,
      imageUrls: optionalStringList(body.imageUrls),
      sizes: Array.isArray(body.sizes)
        ? body.sizes.map((s: any) => ({ label: String(s?.label ?? ""), price: Number(s?.price) }))
        : undefined,
      prepHours: body.prepHours !== undefined ? Number(body.prepHours) : undefined,
      contains: optionalStringList(body.contains),
      whoIsItFor: optionalStringList(body.whoIsItFor),
      highlights: optionalStringList(body.highlights),
      careNote: body.careNote !== undefined ? String(body.careNote) : undefined,
    }

    const updated = await updateBakerProduct(
      req,
      {
        bakerId: ctx.bakerId,
        bakerPublicId: ctx.bakerPublicId,
        bakerName: ctx.bakerName,
        bakerSlug: bakerRow.rows[0]?.slug ?? null,
        bakerCity: bakerRow.rows[0]?.city ?? null,
      },
      productId,
      patch
    )

    return res.status(200).json({ product: updated })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""

    if (message === "NOT_FOUND") {
      return res.status(404).json({ error: "We couldn't find that product." })
    }
    if (message.startsWith("REFUSED:")) {
      return res.status(400).json({ error: message.slice("REFUSED:".length) })
    }

    console.error("[API /baker/products/:id PATCH] Error:", error)
    return res.status(500).json({ error: "Couldn't save your changes. Please try again." })
  }
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  const productId = String(req.params.id || "")
  if (!productId) {
    return res.status(400).json({ error: "Product id is required." })
  }

  try {
    await deleteBakerProduct(req, ctx.bakerId, productId)
    return res.status(200).json({ deleted: true, id: productId })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""

    if (message === "NOT_FOUND") {
      return res.status(404).json({ error: "We couldn't find that product." })
    }
    if (message.startsWith("REFUSED:")) {
      // 409, not 400: the request is well-formed, it conflicts with the product's order history.
      return res.status(409).json({ error: message.slice("REFUSED:".length) })
    }

    console.error("[API /baker/products/:id DELETE] Error:", error)
    return res.status(500).json({ error: "Couldn't delete this product. Please try again." })
  }
}
