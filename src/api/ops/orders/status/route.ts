import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import {
  moveOrderAsOps,
  type BakerOrderStatus,
} from "../../../../services/baker-portal/orders"

/**
 * POST /ops/orders/status — ops moves an order's fulfilment state.
 *
 * ── Why ops needs this at all ──────────────────────────────────────────────────────────────────
 * Every baker is an independent business, and until now the only party who could mark an order
 * delivered was that baker. The delivery mark is not a cosmetic status: referral rewards are owed
 * from delivery, so "when does a referrer get paid" was in practice a question about whether a
 * bakery felt like tapping a button. Ops knows when an order landed, and now ops can say so.
 *
 * ── Why ops may make moves a baker may not ─────────────────────────────────────────────────────
 * The baker's rules stop a screen skipping a step that did not happen and make delivered and
 * rejected terminal to a tap. Ops is the party those rules were always deferring to — reopening a
 * wrongly-rejected order is precisely the case the baker service's own comments hand to ops. Every
 * move here is attributed to the ops user who made it.
 *
 * ── Why the first timestamps survive a correction ──────────────────────────────────────────────
 * The service preserves the earliest time each step happened, so tidying up a record never rewrites
 * when delivery actually occurred. That matters beyond tidiness: a referral payout is anchored to
 * the delivery date, and a correction that moved it would move somebody's money with it.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    orderId?: string
    bakerId?: string
    status?: string
    opsUserId?: string
    rejectionReason?: string | null
  }

  const VALID: BakerOrderStatus[] = [
    "new",
    "accepted",
    "baking",
    "ready",
    "delivered",
    "rejected",
  ]

  if (!body.orderId || !body.bakerId) {
    res.status(400).json({ error: "orderId and bakerId are required." })
    return
  }
  if (!body.status || !VALID.includes(body.status as BakerOrderStatus)) {
    res.status(400).json({ error: `status must be one of ${VALID.join(", ")}.` })
    return
  }

  /**
   * The ops user is required, not optional.
   *
   * This is the one write in the system where a person overrides a partner's own record of what
   * happened to an order, and an override with nobody's name on it is the kind of thing that is
   * impossible to explain three months later when a baker disputes it.
   */
  if (!body.opsUserId) {
    res.status(400).json({ error: "opsUserId is required — every override is attributed." })
    return
  }

  try {
    const result = await moveOrderAsOps({
      orderId: body.orderId,
      bakerId: body.bakerId,
      next: body.status as BakerOrderStatus,
      opsUserId: body.opsUserId,
      rejectionReason: body.rejectionReason ?? null,
    })

    res.status(200).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (message === "NOT_FOUND") {
      /* Said plainly rather than as a permission error: ops may act on any order, so the only way to
         reach this is naming a baker who has nothing in it — a wrong id, not a refusal. */
      res.status(404).json({ error: "That baker has nothing in that order." })
      return
    }

    console.error("[ops/orders/status] failed", error)
    res.status(500).json({ error: "Could not update that order." })
  }
}
