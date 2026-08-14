import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../services/baker-portal/guard"
import { listBakerOrders } from "../../../services/baker-portal/orders"

/**
 * GET /baker/orders — the orders this baker has work in.
 *
 * Scoped by the baker_id the guard resolved from the session, inside the query itself, so there is
 * no request shape that widens it to another bakery's orders.
 *
 * Returns only this baker's line items. An add-on sitting in the same order is real and ops can see
 * it, but it is not theirs to make and showing it would only invite them to try.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }

  try {
    return res.status(200).json({ orders: await listBakerOrders(guard.ctx.bakerId) })
  } catch (error) {
    console.error("[API /baker/orders GET] Error:", error)
    return res.status(500).json({ error: "Couldn't load your orders. Please try again." })
  }
}
