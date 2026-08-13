import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../services/baker-portal/guard"
import { getBakerNetworkDbPool } from "../../../services/baker-network/db"
import {
  BAKER_CATEGORIES,
  createBakerProduct,
  type CreateBakerProductInput,
} from "../../../services/baker-portal/products"

/**
 * GET  /baker/products  — this baker's products
 * POST /baker/products  — create one
 *
 * Both start from the session, never from a body field. The listing query is scoped by the
 * baker_id the guard resolved, so there is no request shape that can widen it to another bakery's
 * products — the isolation is a property of the query, not a check that could be forgotten.
 */

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  try {
    const db = getBakerNetworkDbPool()

    // baker_products lives in baker_network and the product lives in Medusa's schema — same
    // database, so one join answers this rather than a round trip per product. At 54ms per hop,
    // an N+1 here would be the difference between a snappy list and an unusable one.
    const result = await db.query(
      `SELECT bp.medusa_product_id, bp.publication_state, bp.published_at, bp.updated_at,
              p.title, p.handle, p.thumbnail, p.status AS medusa_status,
              (SELECT COUNT(*)::INT FROM public.product_variant v WHERE v.product_id = p.id) AS variant_count,
              (SELECT MIN(ma.amount)::INT
                 FROM public.product_variant v
                 JOIN public.product_variant_money_amount pvma ON pvma.variant_id = v.id
                 JOIN public.money_amount ma ON ma.id = pvma.money_amount_id
                WHERE v.product_id = p.id AND ma.currency_code = 'inr') AS min_price,
              c.name AS category
         FROM baker_network.baker_products bp
         JOIN public.product p ON p.id = bp.medusa_product_id
         LEFT JOIN public.product_category_product pcp ON pcp.product_id = p.id
         LEFT JOIN public.product_category c ON c.id = pcp.product_category_id
        WHERE bp.baker_id = $1 AND bp.publication_state <> 'archived'
        ORDER BY bp.updated_at DESC
        LIMIT 200`,
      [ctx.bakerId]
    )

    return res.status(200).json({
      products: result.rows.map((row) => ({
        id: row.medusa_product_id,
        title: row.title,
        handle: row.handle,
        thumbnail: row.thumbnail,
        category: row.category,
        state: row.publication_state,
        variantCount: row.variant_count,
        // Back to rupees for display — the portal should never have to know about paise.
        fromPrice: row.min_price != null ? row.min_price / 100 : null,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
      })),
    })
  } catch (error) {
    console.error("[API /baker/products GET] Error:", error)
    return res.status(500).json({ error: "Couldn't load your products. Please try again." })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  try {
    const body = (req.body ?? {}) as Partial<CreateBakerProductInput>

    // The baker's own slug and city are denormalised onto product metadata for cheap rendering and
    // for the generated SEO description. Still only a read cache — authorization never consults it.
    const db = getBakerNetworkDbPool()
    const bakerRow = await db.query(
      `SELECT slug, city FROM baker_network.bakers WHERE id = $1`,
      [ctx.bakerId]
    )

    const created = await createBakerProduct(
      req,
      {
        bakerId: ctx.bakerId,
        bakerPublicId: ctx.bakerPublicId,
        bakerUserId: ctx.bakerUserId,
        bakerName: ctx.bakerName,
        bakerSlug: bakerRow.rows[0]?.slug ?? null,
        bakerCity: bakerRow.rows[0]?.city ?? null,
      },
      {
        name: String(body.name ?? ""),
        categoryId: String(body.categoryId ?? ""),
        typeValue: String(body.typeValue ?? ""),
        description: body.description ? String(body.description) : undefined,
        // `imageUrl` (singular) is still accepted so an older client, or a caller written against
        // the previous shape, keeps working rather than silently losing its photo.
        imageUrls: Array.isArray(body.imageUrls)
          ? body.imageUrls.map((u) => String(u))
          : (body as { imageUrl?: string }).imageUrl
            ? [String((body as { imageUrl?: string }).imageUrl)]
            : undefined,
        sizes: Array.isArray(body.sizes)
          ? body.sizes.map((s) => ({ label: String(s?.label ?? ""), price: Number(s?.price) }))
          : [],
        prepHours: body.prepHours != null ? Number(body.prepHours) : undefined,
        // Read field by field, never spread: buildBakerProductMetadata only emits known keys, and
        // this keeps the request body from being the shape of what gets stored.
        contains: body.contains as string[] | undefined,
        whoIsItFor: body.whoIsItFor as string[] | undefined,
        highlights: body.highlights as string[] | undefined,
        careNote: body.careNote ? String(body.careNote) : undefined,
      }
    )

    return res.status(201).json({ product: created })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong."
    // validateBakerProduct throws messages written for a baker to read, so those are surfaced as
    // they are. Anything else is a real fault and gets logged, not shown.
    const isValidation = !message.includes("\n") && message.length < 160 && !/[{}]/.test(message)
    if (!isValidation) {
      console.error("[API /baker/products POST] Error:", error)
    }
    return res.status(isValidation ? 400 : 500).json({
      error: isValidation ? message : "Couldn't save this product. Please try again.",
    })
  }
}

/** Exposed so the portal's form renders exactly the categories the backend will accept. */
export const CATEGORIES = BAKER_CATEGORIES

