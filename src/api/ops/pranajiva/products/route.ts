import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import type { EntityManager } from "typeorm"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * Catalogue writes for the PranaJiva products screen in OPS.
 *
 * ── Why OPS cannot just write SQL ─────────────────────────────────────────────────────────────
 * It reads Postgres directly for everything it displays, and that is fine. Creating or changing a
 * product is not: Medusa fires hooks, events and search indexing off its own services, and an
 * UPDATE from outside skips all of it silently. The product looks right in the database and is
 * wrong everywhere that listens. So reads stay in OPS and writes come here — the same split
 * baker visibility already uses.
 *
 * ── Why one route with an action ──────────────────────────────────────────────────────────────
 * Every operation here shares the same guard, the same brand check and the same failure shape, and
 * splitting them into five files would be five copies of all three. The action is validated
 * against a closed list, so it is not a dispatcher onto arbitrary behaviour.
 *
 * ── The brand check is not a formality ────────────────────────────────────────────────────────
 * This endpoint can edit any product id it is given, and the backend serves CrossFriend from the
 * same database. Every action therefore re-reads the product and refuses one that is not
 * PranaJiva's, rather than trusting that the screen only ever sends its own. A bug in a URL must
 * not be able to rename a cake.
 */

type Action = "create" | "update" | "archive" | "restore" | "setImages" | "setPrice"

const ACTIONS: Action[] = ["create", "update", "archive", "restore", "setImages", "setPrice"]

/** Medusa's own statuses. `published` is the only one the storefront shows. */
const STATUSES = ["draft", "proposed", "published", "rejected"]

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as Record<string, any>
  const action = String(body.action ?? "") as Action

  if (!ACTIONS.includes(action)) {
    res.status(400).json({ error: `action must be one of ${ACTIONS.join(", ")}.` })
    return
  }

  const productService: any = req.scope.resolve("productService")
  const manager: EntityManager = req.scope.resolve("manager")

  try {
    switch (action) {
      case "create":
        res.status(200).json(await create(req, body, productService, manager))
        return
      case "update":
        res.status(200).json(await update(body, productService, manager))
        return
      case "archive":
      case "restore":
        res.status(200).json(await setStatus(body, action, productService, manager))
        return
      case "setImages":
        res.status(200).json(await setImages(body, productService, manager))
        return
      case "setPrice":
        res.status(200).json(await setPrice(body, manager))
        return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ops/pranajiva/products ${action}]`, message)
    res.status(400).json({ error: message })
  }
}

/* ── Guards ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Refuses a product that is not PranaJiva's, and returns it when it is.
 *
 * Brand lives on the product's own metadata or on its collection's — both count, because the
 * catalogue genuinely uses both today and treating the collection route as invalid would lock
 * somebody out of editing Moringa Powder, which reaches the site that way.
 */
async function assertOurs(manager: EntityManager, productId: string): Promise<Record<string, any>> {
  const rows = await manager.query(
    `SELECT p.id, p.handle, p.title, p.metadata, p.status,
            pc.metadata->>'brand' AS collection_brand
       FROM product p
       LEFT JOIN product_collection pc ON pc.id = p.collection_id
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [productId]
  )
  if (!rows.length) throw new Error("That product does not exist.")

  const row = rows[0]
  const ownBrand = (row.metadata ?? {})?.brand
  if (ownBrand !== "pranajiva" && row.collection_brand !== "pranajiva") {
    throw new Error("That product does not belong to PranaJiva.")
  }
  return row
}

/** Lowercase, hyphenated, no leading or trailing hyphen — the shape every existing handle has. */
function normaliseHandle(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/* ── Actions ────────────────────────────────────────────────────────────────────────────────── */

/**
 * A new product, created ready to sell.
 *
 * One variant with an INR price, because a product without either cannot be added to a cart and
 * would be created into a state the storefront treats as broken. `brand` is written here rather
 * than left to the editor for the same reason: a product created without it does not appear on
 * pranajiva.in, and "created successfully, invisible everywhere" is the worst possible outcome of
 * pressing Create.
 *
 * Status is draft. Creating something customers can immediately buy, before anyone has added a
 * photograph or checked the price, is not a default worth having.
 */
async function create(
  req: MedusaRequest,
  body: Record<string, any>,
  productService: any,
  manager: EntityManager
): Promise<{ id: string; handle: string }> {
  const title = String(body.title ?? "").trim()
  if (!title) throw new Error("A title is required.")

  const handle = normaliseHandle(String(body.handle ?? "") || title)
  if (!handle) throw new Error("That title does not produce a usable handle — set one explicitly.")

  const clash = await manager.query(
    `SELECT id FROM product WHERE handle = $1 AND deleted_at IS NULL`,
    [handle]
  )
  if (clash.length) throw new Error(`The handle “${handle}” is already taken.`)

  const rupees = Number(body.priceRupees)
  if (!Number.isFinite(rupees) || rupees <= 0) {
    throw new Error("A price in rupees is required, and must be above zero.")
  }

  const defaultProfile = await manager
    .query(`SELECT id FROM shipping_profile WHERE type = 'default' LIMIT 1`)
    .then((r: any[]) => r[0] ?? null)

  const created = await productService.withTransaction(manager).create({
    title,
    handle,
    description: String(body.description ?? "").trim() || undefined,
    status: "draft",
    discountable: true,
    is_giftcard: false,
    collection_id: body.collectionId ? String(body.collectionId) : undefined,
    profile_id: defaultProfile?.id,
    metadata: {
      brand: "pranajiva",
      ...(body.wellnessCategory ? { wellness_category: String(body.wellnessCategory) } : {}),
    },
    /* Medusa needs an option for variants to vary along, even when there is only one of them. */
    options: [{ title: "Size" }],
    variants: [
      {
        title: String(body.variantTitle ?? "").trim() || "Default",
        sku: String(body.sku ?? "").trim() || undefined,
        manage_inventory: false,
        inventory_quantity: 0,
        variant_rank: 0,
        options: [{ value: String(body.variantTitle ?? "").trim() || "Default" }],
        /* Medusa stores money in the currency's smallest unit. */
        prices: [{ currency_code: "inr", amount: Math.round(rupees * 100) }],
      },
    ],
  })

  return { id: created.id, handle }
}

/**
 * Title, description, placement and the brand metadata.
 *
 * `metadata` arrives as the complete set of fields the editor knows about, with a cleared field
 * sent as an empty string. That is Medusa's own convention — setMetadata merges what it is given
 * and treats `""` as "remove this key" — so clearing a field in the form actually removes it
 * rather than storing an empty value that reads as present everywhere it is checked.
 */
async function update(
  body: Record<string, any>,
  productService: any,
  manager: EntityManager
): Promise<{ id: string }> {
  const id = String(body.productId ?? "")
  if (!id) throw new Error("productId is required.")
  await assertOurs(manager, id)

  const patch: Record<string, any> = {}

  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim()
  if (typeof body.subtitle === "string") patch.subtitle = body.subtitle.trim() || null
  if (typeof body.description === "string") patch.description = body.description.trim() || null

  if (typeof body.handle === "string" && body.handle.trim()) {
    const handle = normaliseHandle(body.handle)
    const clash = await manager.query(
      `SELECT id FROM product WHERE handle = $1 AND id <> $2 AND deleted_at IS NULL`,
      [handle, id]
    )
    if (clash.length) throw new Error(`The handle “${handle}” is already taken.`)
    patch.handle = handle
  }

  if (typeof body.status === "string" && body.status) {
    if (!STATUSES.includes(body.status)) throw new Error("Unknown status.")
    patch.status = body.status
  }

  /* Null clears the collection; undefined leaves it alone. The two are different intentions and
     the screen can express both. */
  if (body.collectionId !== undefined) {
    patch.collection_id = body.collectionId ? String(body.collectionId) : null
  }

  if (body.metadata && typeof body.metadata === "object") {
    patch.metadata = body.metadata as Record<string, unknown>
  }

  if (Object.keys(patch).length === 0) return { id }

  await productService.withTransaction(manager).update(id, patch)
  return { id }
}

/**
 * Hide a product, or bring it back.
 *
 * Archive sets the status to `rejected`, which is Medusa's own "not for sale" state, rather than
 * deleting. A product that has been ordered cannot be deleted without orphaning the order lines
 * that reference its variants, and the whole point of removing one is usually "stop selling this",
 * which is reversible and should stay that way. The storefront, the sitemap and the Google feed
 * all read `published`, so archiving removes it from every one of them.
 */
async function setStatus(
  body: Record<string, any>,
  action: "archive" | "restore",
  productService: any,
  manager: EntityManager
): Promise<{ id: string; status: string }> {
  const id = String(body.productId ?? "")
  if (!id) throw new Error("productId is required.")
  await assertOurs(manager, id)

  const status = action === "archive" ? "rejected" : "published"
  await productService.withTransaction(manager).update(id, { status })
  return { id, status }
}

/**
 * The gallery and the thumbnail together.
 *
 * Medusa keeps them separate — `thumbnail` is what listings, the sitemap, the Merchant feed and
 * the social preview read, `images` is the gallery on the product page — and they drift apart the
 * moment they are set independently. The first image is the thumbnail unless one is named, so
 * reordering in the screen does the obvious thing.
 *
 * An empty list is allowed: it is how a wrong photograph gets removed. It does mean the product
 * leaves the Merchant feed, which the screen says before it happens.
 */
async function setImages(
  body: Record<string, any>,
  productService: any,
  manager: EntityManager
): Promise<{ id: string; count: number }> {
  const id = String(body.productId ?? "")
  if (!id) throw new Error("productId is required.")
  await assertOurs(manager, id)

  const urls: string[] = Array.isArray(body.images)
    ? body.images.map((u: unknown) => String(u)).filter((u: string) => /^https?:\/\//.test(u))
    : []

  const thumbnail =
    typeof body.thumbnail === "string" && /^https?:\/\//.test(body.thumbnail)
      ? body.thumbnail
      : urls[0] ?? null

  await productService.withTransaction(manager).update(id, { images: urls, thumbnail })
  return { id, count: urls.length }
}

/**
 * The INR price of one variant.
 *
 * Written against product_variant_money_amount, which is where this Medusa version links a variant
 * to its amounts — money_amount has no variant_id column, and assuming it does is a mistake this
 * code made once already.
 *
 * Only the default price is touched: a row with a price_list_id is a sale or a customer-group
 * override, and quietly rewriting one from a product screen would change a promotion nobody was
 * looking at.
 */
async function setPrice(
  body: Record<string, any>,
  manager: EntityManager
): Promise<{ variantId: string; amount: number }> {
  const variantId = String(body.variantId ?? "")
  if (!variantId) throw new Error("variantId is required.")

  const rupees = Number(body.priceRupees)
  if (!Number.isFinite(rupees) || rupees <= 0) throw new Error("Price must be above zero.")
  const amount = Math.round(rupees * 100)

  const owner = await manager.query(
    `SELECT product_id FROM product_variant WHERE id = $1 AND deleted_at IS NULL`,
    [variantId]
  )
  if (!owner.length) throw new Error("That variant does not exist.")
  await assertOurs(manager, owner[0].product_id)

  await manager.transaction(async (tm) => {
    const existing = await tm.query(
      `SELECT ma.id
         FROM product_variant_money_amount pvma
         JOIN money_amount ma ON ma.id = pvma.money_amount_id
        WHERE pvma.variant_id = $1 AND pvma.deleted_at IS NULL
          AND ma.currency_code = 'inr' AND ma.deleted_at IS NULL
          AND ma.price_list_id IS NULL
        LIMIT 1`,
      [variantId]
    )

    if (existing.length) {
      await tm.query(`UPDATE money_amount SET amount = $2, updated_at = now() WHERE id = $1`, [
        existing[0].id,
        amount,
      ])
      return
    }

    /* No default INR price yet — the state the list screen flags as "cannot be added to a cart". */
    const maId = `ma_${cuid()}`
    await tm.query(
      `INSERT INTO money_amount (id, currency_code, amount, created_at, updated_at)
       VALUES ($1, 'inr', $2, now(), now())`,
      [maId, amount]
    )
    await tm.query(
      `INSERT INTO product_variant_money_amount (id, money_amount_id, variant_id, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())`,
      [`pvma_${cuid()}`, maId, variantId]
    )
  })

  return { variantId, amount }
}

/** Medusa ids are prefixed ULID-ish strings; this only has to be unique and collision-safe. */
function cuid(): string {
  return (
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 12).toUpperCase()
  )
}
