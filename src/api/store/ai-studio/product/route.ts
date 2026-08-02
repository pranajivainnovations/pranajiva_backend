import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { evaluatePrice, persistEvaluation } from "../../../../services/pricing/pricing-engine"

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
 * Called once when the customer commits to searching for a baker (all price-determining selections
 * are final at that point) — not at Generate or "Use this design," both of which are too early and
 * too exploratory (most generated/selected designs are never priced out, let alone ordered). If the
 * customer goes back and changes a selection afterward, the same productId/variantId is passed back
 * in and this route updates the existing product instead of creating a duplicate.
 *
 * Request body:
 *   {
 *     productId?, variantId?: string    (pass both to update an already-created product instead of creating a new one)
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

    const result = await evaluatePrice({
      categoryKey: "cake",
      pincode: body.pincode,
      weight: body.weight,
      selections,
    })

    const customerId = req.user?.customer_id

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

    if (body.productId && body.variantId) {
      // Selections changed since this design's product was first created — update it in place
      // rather than creating a duplicate for the same design. Title/description/thumbnail live on
      // the product; price/metadata live on the variant — updating the variant alone silently
      // leaves the old title in place (caught live: price updated correctly, title didn't).
      await productService.update(body.productId, {
        title,
        description: body.compiledPrompt || "AI-designed custom cake",
        thumbnail: body.designImageUrl,
        metadata,
      })
      await productVariantService.update(body.variantId, {
        prices: [{ currency_code: "inr", amount: unitPrice }],
        metadata,
      })

      return res.status(200).json({
        productId: body.productId,
        variantId: body.variantId,
        total: result.total,
        breakdown: result.breakdown,
        evaluationId,
      })
    }

    const shippingProfileService = req.scope.resolve("shippingProfileService")
    const salesChannelService = req.scope.resolve("salesChannelService")
    const defaultProfile = await shippingProfileService.retrieveDefault()
    // Real bug, caught live: this install has sales channels enabled, and a product with none
    // assigned gets rejected the moment it's added to a cart ("must belong to the sales channel on
    // which the cart has been created") — not a theoretical edge case, the very first add-to-cart hit it.
    const defaultSalesChannel = await salesChannelService.retrieveDefault()

    const created = await productService.create({
      title,
      description: body.compiledPrompt || "AI-designed custom cake",
      status: "draft", // never shows in public catalog/search — every order carries a customer's own personalization
      discountable: false,
      is_giftcard: false,
      thumbnail: body.designImageUrl,
      type: { value: "AI Custom Cake" },
      profile_id: defaultProfile?.id,
      sales_channels: defaultSalesChannel ? [{ id: defaultSalesChannel.id }] : undefined,
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
