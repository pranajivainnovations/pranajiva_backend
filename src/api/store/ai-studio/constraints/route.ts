import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { evaluateConstraints } from "../../../../services/constraints/constraint-engine"

/**
 * POST /store/ai-studio/constraints
 *
 * Which option combinations are currently allowed, for a partially-made selection.
 *
 * The same answer already rides along on /store/ai-studio/price, but that route needs a weight and a
 * pincode before it can price anything — so constraints only became visible late in the flow, after
 * the customer had confirmed a delivery area. That's backwards: the point of a constraint is to stop
 * someone building an impossible cake in the first place, which happens up in the design step where
 * tiers and shape are chosen.
 *
 * Constraints genuinely don't depend on region or weight, so this route asks for neither. Every field
 * is optional — an empty body returns the unconstrained option space, which is exactly what a form
 * with nothing chosen yet should render.
 *
 * Response 200: { options, violations }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const body = (req.body ?? {}) as {
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
    }

    const result = await evaluateConstraints({
      categoryKey: "cake",
      selections: {
        weight: body.weight,
        tiers: body.tiers,
        shape: body.shape,
        style: body.style,
        flavor: body.flavor,
        // Booleans become the same "on" token the pricing engine uses internally, so both engines see
        // an equivalent selection for toggle attributes.
        express_delivery: body.expressDelivery ? "on" : undefined,
        midnight_delivery: body.midnightDelivery ? "on" : undefined,
        message_on_cake: body.messageOnCake ? "on" : undefined,
        photo_on_cake: body.photoOnCake ? "on" : undefined,
      },
    })

    return res.status(200).json({
      options: result.options,
      violations: result.violations,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[API /store/ai-studio/constraints] Error:", message)
    // Never block the form on this — an unconstrained option space is a safe answer, and the price
    // route plus the save-time backstop both re-check before anything is actually ordered.
    return res.status(200).json({ options: [], violations: [] })
  }
}
