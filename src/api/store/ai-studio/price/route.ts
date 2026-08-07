import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { evaluatePrice, persistEvaluation } from "../../../../services/pricing/pricing-engine"
import { evaluateConstraints } from "../../../../services/constraints/constraint-engine"

/**
 * POST /store/ai-studio/price
 *
 * Computes the authoritative AI Cake Studio price server-side, from the `pricing` schema OPS edits —
 * never trusts a client-sent total. Replaces the old purely-client-side Price Estimator math for
 * anything that needs a real number (checkout). The live estimator UI can keep doing fast client
 * preview math for responsiveness, but only this route's number is ever used for an actual order.
 *
 * Also returns option-validity state from the (independent) constraints engine in the same response —
 * one request answers both "how much" and "what's allowed," so the frontend can grey out invalid
 * choices without a second round trip. Pricing and constraints are evaluated as two unrelated calls
 * that this route composes; neither engine knows the other exists.
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
 *   }
 *
 * Deliberately does NOT accept `addons`. The evaluator supports add-on lines, but their amounts must
 * be resolved server-side from Medusa's own product/variant data — accepting them from the request
 * body let a caller post any amount (including a negative one) and get a total back to match, which
 * both poisoned the pricing.price_evaluations audit trail and would have become a real payment bypass
 * the moment this number was wired into the order path. When add-ons become real, resolve their
 * prices here from their Medusa variant ids; never from the request.
 *
 * Response 200: { total, breakdown: [{label, amount}], evaluationId, constraints: { options, violations } }
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

    // The constraints engine works on plain string value tokens per attribute (it doesn't know what a
    // "boolean toggle" is) — translate booleans to the "on" token the same way evaluatePrice does
    // internally, so both engines see an equivalent selection for these attributes.
    const constraintSelections = {
      weight: body.weight,
      tiers: body.tiers,
      shape: body.shape,
      style: body.style,
      flavor: body.flavor,
      express_delivery: body.expressDelivery ? "on" : undefined,
      midnight_delivery: body.midnightDelivery ? "on" : undefined,
      message_on_cake: body.messageOnCake ? "on" : undefined,
      photo_on_cake: body.photoOnCake ? "on" : undefined,
    }

    const [result, constraintResult] = await Promise.all([
      evaluatePrice({
        categoryKey: "cake",
        pincode: body.pincode,
        weight: body.weight,
        selections,
      }),
      evaluateConstraints({
        categoryKey: "cake",
        selections: constraintSelections,
      }),
    ])

    const evaluationId = await persistEvaluation({
      result,
      pincode: body.pincode,
      selections: { weight: body.weight, ...selections },
      customerId: req.user?.customer_id,
    })

    return res.status(200).json({
      total: result.total,
      breakdown: result.breakdown.map((b) => ({ label: b.label, amount: b.amount })),
      evaluationId,
      constraints: { options: constraintResult.options, violations: constraintResult.violations },
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
