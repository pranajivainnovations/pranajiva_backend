import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../../../services/baker-portal/guard"
import {
  applyPublicationState,
  PUBLICATION_STATES,
  type PublicationState,
} from "../../../../../services/baker-portal/publication"

/**
 * POST /baker/products/:id/state
 *
 * Body: { state: "draft" | "published" | "unavailable" | "archived" }
 *
 * The one way a baker changes whether their product is on sale. Ownership is re-checked inside the
 * transaction against the SESSION's baker, so the :id in the URL can name any product in the
 * database and still only work if this baker owns it.
 *
 * A product owned by someone else returns 404, not 403 — being told "you may not touch this" would
 * confirm the id exists, which is a small leak that costs nothing to avoid.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  const productId = String(req.params.id || "")
  const body = (req.body ?? {}) as { state?: string }
  const next = String(body.state ?? "") as PublicationState

  if (!PUBLICATION_STATES.includes(next)) {
    return res.status(400).json({ error: "Unknown status." })
  }

  try {
    const result = await applyPublicationState(req, ctx.bakerId, productId, next)
    return res.status(200).json({ product: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""

    if (message === "NOT_FOUND") {
      return res.status(404).json({ error: "We couldn't find that product." })
    }
    if (message.startsWith("REFUSED:")) {
      return res.status(409).json({ error: message.slice("REFUSED:".length) })
    }

    console.error("[API /baker/products/:id/state] Error:", error)
    return res.status(500).json({ error: "Couldn't update this product. Please try again." })
  }
}
