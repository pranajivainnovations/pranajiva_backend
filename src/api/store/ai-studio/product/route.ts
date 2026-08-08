import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { evaluatePrice, persistEvaluation } from "../../../../services/pricing/pricing-engine"
import { evaluateConstraints } from "../../../../services/constraints/constraint-engine"
import { getAiStudioDbPool } from "../../../../services/ai-image/db"
import { getCrossFriendChannelId } from "../../../../services/baker-portal/publication"

/**
 * Looks up an existing (design_id, customer_id) → product/variant link. DB is authoritative over
 * whatever the frontend's React state remembers — a page reload or re-picking the same design from
 * the gallery loses that state, but this lookup still finds the customer's already-created product,
 * so a retry never creates a duplicate.
 */
async function findLinkedProduct(
  designId: string,
  customerId: string
): Promise<{ productId: string; variantId: string } | null> {
  const db = getAiStudioDbPool()
  const res = await db.query(
    `SELECT medusa_product_id, medusa_variant_id FROM ai_studio.design_products
     WHERE design_id = $1 AND customer_id = $2`,
    [designId, customerId]
  )
  if (res.rows.length === 0) return null
  return { productId: res.rows[0].medusa_product_id, variantId: res.rows[0].medusa_variant_id }
}

async function linkProduct(
  designId: string,
  customerId: string,
  productId: string,
  variantId: string
): Promise<void> {
  const db = getAiStudioDbPool()
  const linked = await db.query(
    `INSERT INTO ai_studio.design_products (design_id, customer_id, medusa_product_id, medusa_variant_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (design_id, customer_id)
     DO UPDATE SET medusa_product_id = $3, medusa_variant_id = $4, updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [designId, customerId, productId, variantId]
  )

  // `cake_designs.order_count` existed from the original schema but nothing ever wrote to it, so every
  // design read as never-ordered. Count it here — the moment a customer commits to a design and it
  // becomes a real priced product — rather than at order completion, because that's the signal the
  // showcase gallery actually wants: how many people wanted this cake enough to configure it for real.
  //
  // Only on a genuine INSERT. `xmax = 0` distinguishes an inserted row from one the ON CONFLICT branch
  // updated, so the same customer re-saving the same design (a reload, a tweak, re-picking it from the
  // gallery) doesn't inflate the number.
  if (linked.rows[0]?.inserted) {
    await db.query(
      `UPDATE ai_studio.cake_designs SET order_count = order_count + 1 WHERE id = $1`,
      [designId]
    )
  }
}

/**
 * Builds a real, descriptive, SEO-friendly title from the actual selections — never a flat generic
 * "Custom AI Cake" for every order. Kept simple and deterministic (no LLM call) since it only needs
 * to read back the same selections already used to price the cake.
 */
function buildCakeTitle(input: {
  weight: string
  tiers?: string
  shape?: string
  style?: string
  flavor?: string
  occasion?: string
}): string {
  const parts: string[] = []
  if (input.tiers && input.tiers !== "1") parts.push(`${input.tiers}-Tier`)
  if (input.shape && input.shape !== "Round") parts.push(input.shape)
  if (input.style) parts.push(input.style)
  if (input.flavor) parts.push(input.flavor)
  parts.push("Cake")
  let title = parts.join(" ")
  if (input.occasion) title += ` for ${input.occasion}`
  title += ` — ${input.weight}kg`
  return title
}

/**
 * POST /store/ai-studio/product
 *
 * Creates (or, if productId/variantId are given, updates) a real Medusa product + variant for an AI
 * Cake Studio design, with the pricing engine's computed total set as the variant's actual stored
 * price — not an override. This is the replacement for the old shared-variant + price-override
 * approach: by the time a customer clicks "Order Now," this product already exists with a correct
 * price, so adding it to a cart is genuinely standard Medusa — no custom pricing route needed, and
 * nothing for Medusa's own repricing logic to ever clobber, because there's no override to clobber.
 *
 * Called once when the customer clicks "Order Now" on a specific baker (all price-determining
 * selections are final at that point) — not at Generate or "Use this design," both of which are too
 * early and too exploratory (most generated/selected designs are never priced out, let alone
 * ordered). If the customer goes back and changes a selection afterward, the same productId/variantId
 * is passed back in and this route updates the existing product instead of creating a duplicate.
 *
 * Duplicate protection is two-layered: the frontend passes back productId/variantId once it has them
 * in React state (cheapest, no DB round trip), but that state is lost on a page reload or when the
 * same design is re-picked from the showcase gallery in a fresh session. For that case, pass
 * `designId` (the ai_studio.cake_designs id) — this route looks up ai_studio.design_products for an
 * existing (designId, customerId) link and treats that as authoritative over whatever the client
 * sent, so a lost-state retry updates the customer's existing product instead of creating a second
 * one. The link is scoped per-customer, not global on the design, since a showcase design can be
 * picked by many different customers and each must get their own product/variant.
 *
 * Request body:
 *   {
 *     productId?, variantId?: string    (pass both to update an already-created product instead of creating a new one)
 *     designId?: string                 (ai_studio.cake_designs id — enables DB-backed dedup, see above)
 *     weight: string                    (required, e.g. "1.5")
 *     tiers?, shape?, style?, flavor?, occasion?: string
 *     expressDelivery?, midnightDelivery?, messageOnCake?, photoOnCake?: boolean
 *     cakeMessage?: string
 *     pincode?: string                  (6 digits — region resolution for pricing)
 *     designImageUrl?: string
 *     compiledPrompt?: string
 *   }
 *
 * Response 200: { productId, variantId, total, breakdown, evaluationId }
 * Response 400: bad input
 * Response 500: internal error
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const body = req.body as {
      productId?: string
      variantId?: string
      weight?: string
      tiers?: string
      shape?: string
      style?: string
      flavor?: string
      occasion?: string
      expressDelivery?: boolean
      midnightDelivery?: boolean
      messageOnCake?: boolean
      photoOnCake?: boolean
      cakeMessage?: string
      pincode?: string
      designImageUrl?: string
      compiledPrompt?: string
      designId?: string
    }

    if (!body.weight || typeof body.weight !== "string") {
      return res.status(400).json({ error: "weight is required" })
    }
    if (body.pincode && !/^\d{6}$/.test(body.pincode)) {
      return res.status(400).json({ error: "pincode must be 6 digits" })
    }

    const selections = {
      tiers: body.tiers,
      shape: body.shape,
      style: body.style,
      flavor: body.flavor,
      express_delivery: body.expressDelivery,
      midnight_delivery: body.midnightDelivery,
      message_on_cake: body.messageOnCake,
      photo_on_cake: body.photoOnCake,
    }

    // Save-time backstop — the storefront is expected to keep the customer from picking a disabled
    // combination in the first place (using this same engine's output from /store/ai-studio/price),
    // but nothing has been written yet at this point, so it costs nothing to also refuse here in case
    // that client-side state is stale or bypassed entirely.
    const constraintCheck = await evaluateConstraints({
      categoryKey: "cake",
      selections: {
        weight: body.weight,
        tiers: body.tiers,
        shape: body.shape,
        style: body.style,
        flavor: body.flavor,
        express_delivery: body.expressDelivery ? "on" : undefined,
        midnight_delivery: body.midnightDelivery ? "on" : undefined,
        message_on_cake: body.messageOnCake ? "on" : undefined,
        photo_on_cake: body.photoOnCake ? "on" : undefined,
      },
    })
    if (constraintCheck.violations.length > 0) {
      return res.status(400).json({ error: constraintCheck.violations.map((v) => v.message).join(" ") })
    }

    const result = await evaluatePrice({
      categoryKey: "cake",
      pincode: body.pincode,
      weight: body.weight,
      selections,
    })

    const customerId = req.user?.customer_id

    // DB is authoritative over whatever productId/variantId the frontend's React state remembers —
    // a page reload or re-picking the same design from the gallery loses that state, so if this
    // customer already has a product linked to this exact design, use it instead of trusting (or
    // ignoring) whatever the client happened to send.
    let targetProductId = body.productId
    let targetVariantId = body.variantId
    if (body.designId && customerId) {
      const linked = await findLinkedProduct(body.designId, customerId)
      if (linked) {
        targetProductId = linked.productId
        targetVariantId = linked.variantId
      }
    }

    const evaluationId = await persistEvaluation({
      result,
      pincode: body.pincode,
      selections: { weight: body.weight, ...selections },
      customerId,
    })

    const unitPrice = Math.round(result.total * 100)
    const title = buildCakeTitle({
      weight: body.weight,
      tiers: body.tiers,
      shape: body.shape,
      style: body.style,
      flavor: body.flavor,
      occasion: body.occasion,
    })

    const metadata = {
      aiCakeStudio: true,
      priceEvaluationId: evaluationId,
      weight: body.weight,
      tiers: body.tiers ?? null,
      shape: body.shape ?? null,
      style: body.style ?? null,
      flavor: body.flavor ?? null,
      occasion: body.occasion ?? null,
      expressDelivery: Boolean(body.expressDelivery),
      midnightDelivery: Boolean(body.midnightDelivery),
      messageOnCake: Boolean(body.messageOnCake),
      photoOnCake: Boolean(body.photoOnCake),
      cakeMessage: body.cakeMessage ?? null,
      pincode: body.pincode ?? null,
      compiledPrompt: body.compiledPrompt ?? null,
      priceBreakdown: result.breakdown,
    }

    const productVariantService = req.scope.resolve("productVariantService")

    const productService = req.scope.resolve("productService")

    if (targetProductId && targetVariantId) {
      // Selections changed since this design's product was first created — update it in place
      // rather than creating a duplicate for the same design. Title/description/thumbnail live on
      // the product; price/metadata live on the variant — updating the variant alone silently
      // leaves the old title in place (caught live: price updated correctly, title didn't).
      await productService.update(targetProductId, {
        title,
        description: body.compiledPrompt || "AI-designed custom cake",
        thumbnail: body.designImageUrl,
        metadata,
      })
      await productVariantService.update(targetVariantId, {
        prices: [{ currency_code: "inr", amount: unitPrice }],
        metadata,
      })

      if (body.designId && customerId) {
        await linkProduct(body.designId, customerId, targetProductId, targetVariantId)
      }

      return res.status(200).json({
        productId: targetProductId,
        variantId: targetVariantId,
        total: result.total,
        breakdown: result.breakdown,
        evaluationId,
      })
    }

    const shippingProfileService = req.scope.resolve("shippingProfileService")
    const defaultProfile = await shippingProfileService.retrieveDefault()
    // Real bug, caught live: this install has sales channels enabled, and a product with none
    // assigned gets rejected the moment it's added to a cart ("must belong to the sales channel on
    // which the cart has been created") — not a theoretical edge case, the very first add-to-cart hit it.
    //
    // Deliberately the CROSSFRIEND channel, not salesChannelService.retrieveDefault(). The store's
    // default is Pranajiva's channel, which was harmless only while CrossFriend carts also
    // defaulted there. Now that the storefront creates carts on the crossfriend channel — so baker
    // products can be partitioned and filtered server-side — an AI Studio cake left on Pranajiva's
    // channel would be rejected at add-to-cart. These two must move together or the Studio breaks.
    const crossFriendChannelId = await getCrossFriendChannelId(req.scope.resolve("manager"))

    const created = await productService.create({
      title,
      description: body.compiledPrompt || "AI-designed custom cake",
      status: "draft", // never shows in public catalog/search — every order carries a customer's own personalization
      discountable: false,
      is_giftcard: false,
      thumbnail: body.designImageUrl,
      type: { value: "AI Custom Cake" },
      profile_id: defaultProfile?.id,
      sales_channels: [{ id: crossFriendChannelId }],
      metadata,
      variants: [
        {
          title: "Default",
          manage_inventory: false, // made-to-order, no real inventory to track
          inventory_quantity: 0, // NOT NULL column — irrelevant once manage_inventory is false, but still required
          metadata,
          prices: [{ currency_code: "inr", amount: unitPrice }],
        },
      ],
    })

    // create()'s own return value doesn't reliably come back with variants populated — retrieve
    // explicitly rather than assume its shape.
    const product = await productService.retrieve(created.id, { relations: ["variants"] })
    const variant = product.variants[0]

    if (body.designId && customerId) {
      await linkProduct(body.designId, customerId, product.id, variant.id)
    }

    return res.status(200).json({
      productId: product.id,
      variantId: variant.id,
      total: result.total,
      breakdown: result.breakdown,
      evaluationId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    const isBadInput = message.includes("Unknown") || message.includes("inactive")

    console.error("[API /store/ai-studio/product] Error:", message)

    return res.status(isBadInput ? 400 : 500).json({
      error: isBadInput ? message : "Something went wrong computing the price. Please try again.",
    })
  }
}
