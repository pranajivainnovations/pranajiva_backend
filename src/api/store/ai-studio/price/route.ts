import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { evaluatePrice, persistEvaluation } from "../../../../services/pricing/pricing-engine"

/**
 * POST /store/ai-studio/price
 *
 * Computes the authoritative AI Cake Studio price server-side, from the `pricing` schema OPS edits —
 * never trusts a client-sent total. Replaces the old purely-client-side Price Estimator math for
 * anything that needs a real number (checkout). The live estimator UI can keep doing fast client
 * preview math for responsiveness, but only this route's number is ever used for an actual order.
 *
 * Request body:
 *   {
 *     weight: string              (required, e.g. "1.5")
 *     tiers?: string
 *     shape?: string
 *     style?: string
 *     flavor?: string
 *     expressDelivery?: boolean
 *     midnightDelivery?: boolean
 *     messageOnCake?: boolean
 *     photoOnCake?: boolean
 *     pincode?: string            (6 digits — used for region resolution, "coming soon" pincodes still price fine)
 *     addons?: { label: string, amount: number }[]   (see pricing-engine.ts — NOT re-verified here yet;
 *                                                      the cart/order route that actually spends this
 *                                                      number must resolve addon prices from Medusa
 *                                                      itself, not trust this passthrough)
 *   }
 *
 * Response 200: { total, breakdown: [{label, amount}], evaluationId }
 * Response 400: bad input (unknown weight, missing weight)
 * Response 500: internal error
 *
 * Auth: optional — a price estimate can happen before login (price_evaluations.customer_id is nullable).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const body = req.body as {
      weight?: string
      tiers?: string
      shape?: string
      style?: string
      flavor?: string
      expressDelivery?: boolean
      midnightDelivery?: boolean
      messageOnCake?: boolean
      photoOnCake?: boolean
      pincode?: string
      addons?: { label: string; amount: number }[]
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
      addons: body.addons,
    })

    const evaluationId = await persistEvaluation({
      result,
      pincode: body.pincode,
      selections: { weight: body.weight, ...selections, addons: body.addons },
      customerId: req.user?.customer_id,
    })

    return res.status(200).json({
      total: result.total,
      breakdown: result.breakdown.map((b) => ({ label: b.label, amount: b.amount })),
      evaluationId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    const isBadInput = message.includes("Unknown") || message.includes("inactive")

    console.error("[API /store/ai-studio/price] Error:", message)

    return res.status(isBadInput ? 400 : 500).json({
      error: isBadInput ? message : "Something went wrong computing the price. Please try again.",
    })
  }
}
