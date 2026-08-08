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
  description?: string
  imageUrl?: string
  sizes: BakerProductSize[]
  prepHours?: number
}

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
  baker: { bakerId: string; bakerPublicId: string; bakerUserId: string; bakerName: string; bakerSlug?: string | null },
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

  const name = input.name.trim()
  const handle = await uniqueHandle(manager, buildHandle(name, baker.bakerPublicId))

  // A read cache for rendering only. Ownership is decided by baker_products and nothing else ever
  // consults these — see the guard in every /baker/* route.
  const metadata: Record<string, unknown> = {
    brand: "crossfriend",
    baker_id: baker.bakerPublicId,
    baker_name: baker.bakerName,
    ...(baker.bakerSlug ? { baker_slug: baker.bakerSlug } : {}),
    ...(input.prepHours != null ? { prep_hours: input.prepHours } : {}),
  }

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
      thumbnail: input.imageUrl || undefined,
      images: input.imageUrl ? [input.imageUrl] : undefined,
      profile_id: defaultProfile?.id,
      categories: [{ id: input.categoryId }],
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
