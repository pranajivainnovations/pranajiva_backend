import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../../../services/baker-portal/guard"
import { moveBakerOrder, type BakerOrderStatus } from "../../../../../services/baker-portal/orders"

const STATUSES: BakerOrderStatus[] = [
  "new",
  "accepted",
  "baking",
  "ready",
  "delivered",
  "rejected",
]

/**
 * POST /baker/orders/:id/status
 *
 * Body: { status: "accepted" | "baking" | "ready" | "delivered" | "rejected", reason?: string }
 *
 * The one way a baker moves an order along. Which moves are legal lives in the service, so the
 * portal cannot develop its own opinion about the workflow — it renders whatever buttons the current
 * status allows and the backend refuses anything else regardless.
 *
 * An order this baker has nothing in returns 404, not 403: being told "you may not touch this" would
 * confirm the order exists, which is a small leak that costs nothing to avoid.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  const orderId = String(req.params.id || "")
  const body = (req.body ?? {}) as { status?: string; reason?: string }
  const next = String(body.status ?? "") as BakerOrderStatus

  if (!STATUSES.includes(next)) {
    return res.status(400).json({ error: "Unknown status." })
  }
  if (next === "new") {
    // Not a move anyone makes — it is what "no row yet" already means.
    return res.status(400).json({ error: "That isn't a change you can make." })
  }

  try {
    const result = await moveBakerOrder({
      bakerId: ctx.bakerId,
      orderId,
      next,
      bakerUserId: ctx.bakerUserId,
      rejectionReason: body.reason ? String(body.reason).slice(0, 500) : null,
    })
    return res.status(200).json({ order: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""

    if (message === "NOT_FOUND") {
      return res.status(404).json({ error: "We couldn't find that order." })
    }
    if (message.startsWith("REFUSED:")) {
      return res.status(409).json({ error: message.slice("REFUSED:".length) })
    }

    console.error("[API /baker/orders/:id/status] Error:", error)
    return res.status(500).json({ error: "Couldn't update this order. Please try again." })
  }
}
