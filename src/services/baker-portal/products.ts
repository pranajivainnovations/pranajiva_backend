/**
 * Baker product creation — the one place a baker's form input becomes a real Medusa product.
 *
 * Two things happen together and must never come apart: a Medusa product is created, and a
 * baker_products row records who owns it. They run in ONE transaction, using Medusa's own
 * EntityManager for both — the ownership row is written with `tm.query` rather than through the
 * separate pg pool precisely so it shares the transaction. If the ownership insert fails, the
 * product is rolled back too; an unowned Medusa product is worse than no product, because nothing
 * in the system would ever claim or clean it up.
 *
 * Everything goes through Medusa's services rather than raw SQL so its hooks, events and search
 * indexing fire exactly as they do for any other product.
 *
 * ── Why products are born unpurchasable ─────────────────────────────────────────────────────────
 * A new product is created with Medusa status 'proposed' and NO sales channel. That is not an
 * oversight — it is the draft state:
 *
 *   'proposed'     keeps it out of /store/products entirely (which only returns 'published'),
 *                  without touching Medusa 'draft', whose meaning AI Studio already owns.
 *   no channel     makes it un-addable to any cart — Medusa rejects a line item whose product is
 *                  not on the cart's sales channel.
 *
 * Publishing (Phase 9) flips both. Until then a baker can build a listing at their own pace and
 * nobody can buy a half-finished cake.
 */

import type { MedusaRequest } from "@medusajs/medusa"

import { getBakerNetworkDbPool } from "../baker-network/db"
import { buildBakerProductMetadata, missingForPublish } from "./product-metadata"

/** The Ready-to-Order tree from CreateCrossFriendCatalogTaxonomy. */
export const BAKER_CATEGORIES = [
  { id: "pcat_cf_cakes", label: "Cakes" },
  { id: "pcat_cf_pastries", label: "Pastries" },
  { id: "pcat_cf_desserts", label: "Desserts" },
  { id: "pcat_cf_brownies", label: "Brownies" },
  { id: "pcat_cf_gifts", label: "Gifts" },
  { id: "pcat_cf_decor", label: "Decor" },
] as const

export type BakerCategoryId = (typeof BAKER_CATEGORIES)[number]["id"]

export interface BakerProductSize {
  /** What the customer picks: "1 kg", "6 inch", "Box of 6". Free text — bakers don't think in SKUs. */
  label: string
  /** Rupees, as the baker typed them. Converted to paise below. */
  price: number
}

export interface CreateBakerProductInput {
  name: string
  categoryId: string
  /**
   * CrossFriend product type value — `cake`, `gift`, `costume`… From the taxonomy (OPS → Taxonomy).
   *
   * This is what places the product on occasion pages and behind `/store?type=`, and it is a
   * DIFFERENT axis from categoryId: the category is the marketplace shelf, the type is what the
   * thing is. Products created before this field existed have no type and are invisible to every
   * type filter, which is why it is required rather than optional.
   */
  typeValue: string
  description?: string
  /**
   * In display order. The FIRST becomes the thumbnail — the image every listing, card and search
   * result uses — so order is meaningful and is preserved exactly as the baker arranged it.
   */
  imageUrls?: string[]
  sizes: BakerProductSize[]
  prepHours?: number
  /** Ingredients and allergens. Required before publishing — see missingForPublish. */
  contains?: string[]
  whoIsItFor?: string[]
  highlights?: string[]
  careNote?: string
}

export interface BakerProductTypeOption {
  value: string
  label: string
  emoji: string | null
}

/**
 * The product types a baker may choose from — active CrossFriend types only.
 *
 * Read from the taxonomy rather than hardcoded so a type added in OPS is immediately offerable,
 * and so Pranajiva's types (Herbal Powder, SuperFood) can never appear in a baker's dropdown even
 * though they sit in the same Medusa table.
 */
export async function listBakerProductTypes(): Promise<BakerProductTypeOption[]> {
  const pool = getBakerNetworkDbPool()
  const { rows } = await pool.query(
    `SELECT pt.value, t.label, t.emoji
       FROM crossfriend.product_types t
       JOIN public.product_type pt ON pt.id = t.type_id AND pt.deleted_at IS NULL
      WHERE t.is_active
      ORDER BY t.display_order, t.label`
  )
  return rows.map((r) => ({ value: r.value, label: r.label, emoji: r.emoji }))
}

/** Resolves a type value to its Medusa id, or null if it is not a CrossFriend type. */
async function resolveTypeId(value: string): Promise<string | null> {
  const pool = getBakerNetworkDbPool()
  const { rows } = await pool.query(
    `SELECT pt.id
       FROM crossfriend.product_types t
       JOIN public.product_type pt ON pt.id = t.type_id AND pt.deleted_at IS NULL
      WHERE t.is_active AND lower(pt.value) = lower($1)
      LIMIT 1`,
    [value]
  )
  return rows[0]?.id ?? null
}

/** A baker can attach this many photos to one product. */
const MAX_IMAGES = 6

export interface CreatedBakerProduct {
  productId: string
  handle: string
  publicationState: "draft"
}

const MAX_SIZES = 8
const MAX_PRICE_RUPEES = 500000

/**
 * Validates what a baker typed, in the baker's own terms.
 *
 * Returns a message written to be shown directly in the form — "Add at least one size and price"
 * rather than "sizes: array must have min length 1". The person reading it is a baker, not an
 * engineer, and a validation message is the most-read copy in any form.
 */
export function validateBakerProduct(input: CreateBakerProductInput): string | null {
  if (!input.name?.trim()) return "Give your product a name."
  if (input.name.trim().length > 120) return "That name is too long — keep it under 120 characters."

  if (!BAKER_CATEGORIES.some((c) => c.id === input.categoryId)) {
    return "Choose a category for this product."
  }

  // Only presence is checked here; whether it is a real CrossFriend type is settled by
  // resolveTypeId against the taxonomy, so this validator stays synchronous and testable.
  if (!input.typeValue?.trim()) {
    return "Choose what kind of product this is."
  }

  if (!Array.isArray(input.sizes) || input.sizes.length === 0) {
    return "Add at least one size and price."
  }
  if (input.sizes.length > MAX_SIZES) {
    return `You can add up to ${MAX_SIZES} sizes.`
  }

  const seen = new Set<string>()
  for (const size of input.sizes) {
    const label = size.label?.trim()
    if (!label) return "Every size needs a name, like “1 kg”."
    const key = label.toLowerCase()
    if (seen.has(key)) return `You've added “${label}” twice.`
    seen.add(key)

    if (!Number.isFinite(size.price) || size.price <= 0) {
      return `Enter a price for “${label}”.`
    }
    if (size.price > MAX_PRICE_RUPEES) {
      return `That price for “${label}” looks too high — please check it.`
    }
  }

  if (input.prepHours != null && (!Number.isFinite(input.prepHours) || input.prepHours < 0 || input.prepHours > 720)) {
    return "Preparation time should be between 0 and 720 hours."
  }

  if (input.imageUrls && input.imageUrls.length > MAX_IMAGES) {
    return `You can add up to ${MAX_IMAGES} photos.`
  }

  return null
}

/**
 * Builds a URL-safe handle. Medusa requires it to be unique across ALL products, including
 * Pranajiva's, so the Baker ID is folded in — two bakeries can both sell a "Chocolate Truffle Cake"
 * without one of them silently failing, and the resulting URL says whose it is.
 */
function buildHandle(name: string, bakerPublicId: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "product"
  return `${base}-${bakerPublicId.toLowerCase()}`
}

export async function createBakerProduct(
  req: MedusaRequest,
  baker: {
    bakerId: string
    bakerPublicId: string
    bakerUserId: string
    bakerName: string
    bakerSlug?: string | null
    bakerCity?: string | null
  },
  input: CreateBakerProductInput
): Promise<CreatedBakerProduct> {
  const validationError = validateBakerProduct(input)
  if (validationError) {
    throw new Error(validationError)
  }

  const productService = req.scope.resolve("productService")
  const shippingProfileService = req.scope.resolve("shippingProfileService")
  const manager = req.scope.resolve("manager")

  const defaultProfile = await shippingProfileService.retrieveDefault()

  const typeId = await resolveTypeId(input.typeValue)
  if (!typeId) {
    // A value that is not an active CrossFriend type. Rejecting beats silently creating an untyped
    // product: that is exactly how every product created before this field ended up invisible to
    // occasion pages and type filters.
    throw new Error("That product kind isn't available. Pick one from the list.")
  }

  const name = input.name.trim()
  const handle = await uniqueHandle(manager, buildHandle(name, baker.bakerPublicId))
  const images = (input.imageUrls ?? []).map((u) => u.trim()).filter(Boolean)
  const categoryLabel =
    BAKER_CATEGORIES.find((c) => c.id === input.categoryId)?.label ?? null

  // Built, never spread. buildBakerProductMetadata emits a fixed set of keys, so an ops-only field
  // in the request body (is_addon, kit_eligible) cannot reach the product.
  const metadata = buildBakerProductMetadata(
    {
      bakerPublicId: baker.bakerPublicId,
      bakerName: baker.bakerName,
      bakerSlug: baker.bakerSlug,
      bakerCity: baker.bakerCity,
      productTitle: name,
      categoryLabel,
      prepHours: input.prepHours,
      contains: input.contains,
      whoIsItFor: input.whoIsItFor,
      highlights: input.highlights,
      careNote: input.careNote,
    },
    input.description
  )

  let productId = ""

  await manager.transaction(async (tm: any) => {
    const created = await productService.withTransaction(tm).create({
      title: name,
      handle,
      description: input.description?.trim() || undefined,
      // See the file comment: unpurchasable until published, without touching AI Studio's 'draft'.
      status: "proposed",
      discountable: true,
      is_giftcard: false,
      // Medusa keeps these separate: `thumbnail` is the single image used in listings and search,
      // `images` is the gallery on the product page. The baker's first photo serves as both, so
      // what they arranged in the picker is what customers see everywhere.
      thumbnail: images[0],
      images: images.length ? images : undefined,
      profile_id: defaultProfile?.id,
      categories: [{ id: input.categoryId }],
      // The taxonomy axis: what this thing IS. Category is the marketplace shelf; type is what
      // occasion pages and /store?type= filter on.
      type_id: typeId,
      // Deliberately no sales_channels — that is what publication grants.
      metadata,
      // One variant per size the baker offers. Medusa needs an option for variants to differ along,
      // and "Size" is the only axis a baker product varies on in V1.
      options: [{ title: "Size" }],
      variants: input.sizes.map((size, index) => ({
        title: size.label.trim(),
        // Bakers bake to order — a stock count would be fiction, and would block checkout the
        // moment it hit zero.
        manage_inventory: false,
        inventory_quantity: 0,
        // NOT NULL in Medusa's schema even though it means nothing here.
        variant_rank: index,
        options: [{ value: size.label.trim() }],
        // Medusa stores money in the currency's smallest unit.
        prices: [{ currency_code: "inr", amount: Math.round(size.price * 100) }],
      })),
    })

    productId = created.id

    // Written last and inside the same transaction: if this fails, the product goes with it.
    await tm.query(
      `INSERT INTO baker_network.baker_products
         (baker_id, medusa_product_id, publication_state, created_by)
       VALUES ($1, $2, 'draft', $3)`,
      [baker.bakerId, created.id, baker.bakerUserId]
    )
  })

  return { productId, handle, publicationState: "draft" }
}

/**
 * Everything about a listing a baker may change after creating it.
 *
 * Every field optional, and absent means "leave it alone" — distinct from present-and-empty, which
 * means "clear it". A form that submits only the section being edited must not wipe the rest.
 *
 * `handle` is deliberately not here. It is the product's public URL; renaming a cake should not
 * break a link a customer has already shared, or one Google has already indexed.
 */
export interface UpdateBakerProductInput {
  name?: string
  description?: string
  imageUrls?: string[]
  sizes?: BakerProductSize[]
  prepHours?: number
  contains?: string[]
  whoIsItFor?: string[]
  highlights?: string[]
  careNote?: string
  categoryId?: string
  typeValue?: string
}

export interface UpdatedBakerProduct {
  productId: string
  publicationState: string
  /** Set when a live listing was taken off sale because the edit left it incomplete. */
  unpublishedBecause?: string
}

/**
 * Applies a baker's edits to a listing they own.
 *
 * ── Why the patch is merged into the current record before validating ───────────────────────────
 * `validateBakerProduct` speaks the baker's language ("Add at least one size and price") and already
 * encodes every rule. Reconstructing the full product from what is stored, applying the patch, then
 * running that same validator means one definition of a valid listing rather than two that drift —
 * and it makes a partial edit impossible to use as a way around a rule that create enforces.
 *
 * ── Why editing can take a live product off sale ────────────────────────────────────────────────
 * Publishing checks completeness, but nothing stopped an edit from removing the last photo of an
 * already-published cake, leaving a live listing with no image. Rather than refuse the edit — the
 * baker plainly wants to change something, and being blocked mid-task with no way forward is worse —
 * the edit is accepted and the listing drops back to draft with the reason returned, so they can fix
 * it and publish again.
 */
export async function updateBakerProduct(
  req: MedusaRequest,
  baker: {
    bakerId: string
    bakerPublicId: string
    bakerName: string
    bakerSlug?: string | null
    bakerCity?: string | null
  },
  productId: string,
  input: UpdateBakerProductInput
): Promise<UpdatedBakerProduct> {
  const manager = req.scope.resolve("manager")
  const productService = req.scope.resolve("productService")
  const productVariantService = req.scope.resolve("productVariantService")

  let result: UpdatedBakerProduct | null = null

  await manager.transaction(async (tm: any) => {
    const owned = await tm.query(
      `SELECT publication_state
         FROM baker_network.baker_products
        WHERE baker_id = $1 AND medusa_product_id = $2
        FOR UPDATE`,
      [baker.bakerId, productId]
    )
    // 404 upstream rather than 403 — being refused would confirm the id exists.
    if (!owned.length) throw new Error("NOT_FOUND")
    const publicationState = owned[0].publication_state as string

    const existing = await productService.withTransaction(tm).retrieve(productId, {
      relations: ["variants", "variants.prices", "options", "categories", "images"],
    })

    const meta = (existing.metadata ?? {}) as Record<string, unknown>

    // The current listing expressed as create-shaped input, so the patch can be laid over it and the
    // whole thing validated as one.
    const merged: CreateBakerProductInput = {
      name: input.name ?? existing.title,
      categoryId: input.categoryId ?? existing.categories?.[0]?.id ?? "",
      typeValue: input.typeValue ?? (await typeValueFor(tm, existing.type_id)) ?? "",
      description: input.description ?? existing.description ?? undefined,
      imageUrls:
        input.imageUrls ??
        (existing.images ?? []).map((image: { url: string }) => image.url).filter(Boolean),
      sizes:
        input.sizes ??
        (existing.variants ?? []).map((variant: any) => ({
          label: variant.title,
          // Back to rupees — validation and the baker both think in rupees, Medusa stores paise.
          // `!p.price_list_id` excludes sale prices: without it, a product on promotion would
          // prefill the merge with its discounted price and a partial edit would save that as the
          // permanent one.
          price: (basePriceOf(variant) ?? 0) / 100,
        })),
      prepHours: input.prepHours ?? (meta.prep_hours as number | undefined),
      contains: input.contains ?? (meta.contains as string[] | undefined),
      whoIsItFor: input.whoIsItFor ?? (meta.who_is_it_for as string[] | undefined),
      highlights: input.highlights ?? (meta.highlights as string[] | undefined),
      careNote: input.careNote ?? (meta.care_note as string | undefined),
    }

    const validationError = validateBakerProduct(merged)
    if (validationError) throw new Error(`REFUSED:${validationError}`)

    const typeId = await resolveTypeId(merged.typeValue)
    if (!typeId) throw new Error("REFUSED:That product kind isn't available. Pick one from the list.")

    const name = merged.name.trim()
    const images = (merged.imageUrls ?? []).map((u) => u.trim()).filter(Boolean)
    const categoryLabel = BAKER_CATEGORIES.find((c) => c.id === merged.categoryId)?.label ?? null

    // Rebuilt from the merged record, never spread from the request — an ops-only key in the body
    // still cannot reach the product, exactly as on create.
    const metadata = buildBakerProductMetadata(
      {
        bakerPublicId: baker.bakerPublicId,
        bakerName: baker.bakerName,
        bakerSlug: baker.bakerSlug,
        bakerCity: baker.bakerCity,
        productTitle: name,
        categoryLabel,
        prepHours: merged.prepHours,
        contains: merged.contains,
        whoIsItFor: merged.whoIsItFor,
        highlights: merged.highlights,
        careNote: merged.careNote,
      },
      merged.description
    )

    await productService.withTransaction(tm).update(productId, {
      title: name,
      description: merged.description?.trim() || undefined,
      thumbnail: images[0],
      images,
      categories: [{ id: merged.categoryId }],
      type_id: typeId,
      metadata,
    })

    await reconcileVariants(tm, productVariantService, existing, merged.sizes)

    // An edit that leaves a live listing incomplete takes it off sale rather than being refused.
    let unpublishedBecause: string | undefined
    if (publicationState === "published") {
      const missing = missingForPublish({
        title: name,
        description: merged.description,
        thumbnail: images[0],
        metadata,
        variantCount: merged.sizes.length,
      })
      if (missing.length) {
        unpublishedBecause = `This is no longer ready to be on sale — it needs ${formatMissing(missing)}. We've moved it back to draft.`
        await unpublishInTransaction(tm, productService, baker.bakerId, productId)
      }
    }

    await tm.query(
      `UPDATE baker_network.baker_products SET updated_at = NOW()
        WHERE baker_id = $1 AND medusa_product_id = $2`,
      [baker.bakerId, productId]
    )

    result = {
      productId,
      publicationState: unpublishedBecause ? "draft" : publicationState,
      unpublishedBecause,
    }
  })

  return result!
}

/** A variant's ordinary INR price in paise, ignoring sale and price-list rows. */
function basePriceOf(variant: any): number | undefined {
  return variant.prices?.find((p: any) => p.currency_code === "inr" && !p.price_list_id)?.amount
}

/** Mirrors publication.ts's list formatting — "a photo, a description and at least one size". */
function formatMissing(items: string[]): string {
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/** The type VALUE for a Medusa type id, so an unchanged type survives a partial edit. */
async function typeValueFor(tm: any, typeId: string | null): Promise<string | null> {
  if (!typeId) return null
  const rows = await tm.query(`SELECT value FROM public.product_type WHERE id = $1`, [typeId])
  return rows[0]?.value ?? null
}

/**
 * Brings a product's variants in line with the sizes a baker submitted.
 *
 * Matched by LABEL rather than position. A baker who deletes their middle size and saves would
 * otherwise have every later variant silently renamed and repriced by one place — and because
 * variant ids are what carts and orders reference, that would quietly rewrite the meaning of any
 * cart already holding one. Matching on the label means an untouched size keeps its identity.
 */
async function reconcileVariants(
  tm: any,
  productVariantService: any,
  existing: any,
  sizes: BakerProductSize[]
): Promise<void> {
  const service = productVariantService.withTransaction(tm)
  const optionId = existing.options?.[0]?.id
  const byLabel = new Map<string, any>(
    (existing.variants ?? []).map((v: any) => [v.title.trim().toLowerCase(), v])
  )
  const keep = new Set<string>()

  for (const [index, size] of sizes.entries()) {
    const label = size.label.trim()
    const amount = Math.round(size.price * 100)
    const current = byLabel.get(label.toLowerCase())

    if (current) {
      keep.add(current.id)
      const currentAmount = basePriceOf(current)
      // Only touch what changed — an update rewrites the price rows, and there is no reason to churn
      // them on a save that edited a photo.
      if (currentAmount !== amount || current.variant_rank !== index) {
        await service.update(current.id, {
          variant_rank: index,
          prices: [{ currency_code: "inr", amount }],
        })
      }
      continue
    }

    const created = await service.create(existing.id, {
      title: label,
      manage_inventory: false,
      inventory_quantity: 0,
      variant_rank: index,
      options: optionId ? [{ option_id: optionId, value: label }] : [],
      prices: [{ currency_code: "inr", amount }],
    })
    keep.add(created.id)
  }

  for (const variant of existing.variants ?? []) {
    if (!keep.has(variant.id)) {
      await service.delete(variant.id)
    }
  }
}

/**
 * Takes a product off sale from inside an existing transaction.
 *
 * Deliberately not applyPublicationState: that function opens its own transaction and re-checks the
 * draft→published rules, neither of which applies here. This is the same two-fact projection —
 * Medusa status and channel membership — written directly.
 */
async function unpublishInTransaction(
  tm: any,
  productService: any,
  bakerId: string,
  productId: string
): Promise<void> {
  const { getCrossFriendChannelId } = await import("./publication")
  const channelId = await getCrossFriendChannelId(tm)

  await productService.withTransaction(tm).update(productId, { status: "proposed" })
  await tm.query(
    `DELETE FROM public.product_sales_channel WHERE product_id = $1 AND sales_channel_id = $2`,
    [productId, channelId]
  )
  await tm.query(
    `UPDATE baker_network.baker_products SET publication_state = 'draft', updated_at = NOW()
      WHERE baker_id = $1 AND medusa_product_id = $2`,
    [bakerId, productId]
  )
}

export interface DeleteBakerProductResult {
  productId: string
}

/**
 * Permanently deletes a listing the baker owns.
 *
 * ── Why orders are an absolute block ────────────────────────────────────────────────────────────
 * A line item points at a variant, which points at the product. Delete the product and every order
 * that ever contained it loses the record of what was actually bought — no title, no price, no way
 * to answer a customer asking what they paid for. That is not recoverable from a backup without
 * restoring unrelated data along with it, so it is refused outright rather than warned about.
 *
 * Archiving remains available and is the right answer for anything real: it takes the listing off
 * sale and out of the catalogue while the history stays intact. Deletion is for mistakes — a
 * duplicate, a test listing, something created in the wrong account.
 */
export async function deleteBakerProduct(
  req: MedusaRequest,
  bakerId: string,
  productId: string
): Promise<DeleteBakerProductResult> {
  const manager = req.scope.resolve("manager")
  const productService = req.scope.resolve("productService")

  await manager.transaction(async (tm: any) => {
    const owned = await tm.query(
      `SELECT 1 FROM baker_network.baker_products
        WHERE baker_id = $1 AND medusa_product_id = $2
        FOR UPDATE`,
      [bakerId, productId]
    )
    if (!owned.length) throw new Error("NOT_FOUND")

    const ordered = await tm.query(
      `SELECT COUNT(*)::INT AS n
         FROM public.line_item li
         JOIN public.product_variant v ON v.id = li.variant_id
        WHERE v.product_id = $1`,
      [productId]
    )
    if ((ordered[0]?.n ?? 0) > 0) {
      throw new Error(
        "REFUSED:This product has been ordered, so it can't be deleted — that would erase it from those orders. Archive it instead to take it off sale."
      )
    }

    // Ownership row first: if the product delete then fails, the transaction rolls both back. The
    // reverse order would risk a moment where an existing product has no recorded owner.
    await tm.query(
      `DELETE FROM baker_network.baker_products WHERE baker_id = $1 AND medusa_product_id = $2`,
      [bakerId, productId]
    )
    await tm.query(`DELETE FROM public.product_sales_channel WHERE product_id = $1`, [productId])
    await productService.withTransaction(tm).delete(productId)
  })

  return { productId }
}

/**
 * Medusa's handle column is globally unique, so a collision throws mid-transaction and loses the
 * whole product. Folding in the Baker ID makes collisions rare; this makes them impossible.
 */
async function uniqueHandle(manager: any, base: string): Promise<string> {
  let candidate = base
  let suffix = 1

  // Bounded: a baker listing the same product name 50 times has a different problem.
  for (let i = 0; i < 50; i++) {
    const rows = await manager.query(`SELECT 1 FROM public.product WHERE handle = $1 LIMIT 1`, [
      candidate,
    ])
    if (!rows.length) return candidate
    suffix += 1
    candidate = `${base}-${suffix}`
  }

  return `${base}-${Date.now()}`
}
