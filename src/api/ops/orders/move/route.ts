import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { moveOrderStatus, OpsOrderError, type OrderStatus } from "../../../../services/orders/ops"

/**
 * POST /ops/orders/move — move an order along.
 *
 * ── Why this is not /ops/orders/status ─────────────────────────────────────────────────────────
 * That route already exists and belongs to the Medusa-era baker flow, where a status is a baker's
 * state inside an order. This one moves the ORDER, in the new pipeline, and the two have different
 * ids, different tables and different rules. Reusing the path would have made which one you are
 * talking to depend on the shape of the body.
 *
 * ── What the customer sees ─────────────────────────────────────────────────────────────────────
 * Every move writes to orders.order_events, and the customer's confirmation page draws its progress
 * rail from those same rows. There is no ops-only status: moving an order here changes what the
 * customer reads on their screen.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    orderId?: string
    status?: string
    opsUserId?: string
    note?: string
  }

  const VALID: OrderStatus[] = [
    "placed",
    "accepted",
    "making",
    "out_for_delivery",
    "delivered",
    "cancelled",
  ]

  if (!body.orderId) {
    res.status(400).json({ error: "orderId is required." })
    return
  }
  if (!body.status || !VALID.includes(body.status as OrderStatus)) {
    res.status(400).json({ error: `status must be one of ${VALID.join(", ")}.` })
    return
  }
  if (!body.opsUserId) {
    res.status(400).json({ error: "opsUserId is required — every move is attributed." })
    return
  }

  try {
    const result = await moveOrderStatus({
      orderId: body.orderId,
      next: body.status as OrderStatus,
      opsUserId: body.opsUserId,
      note: body.note ?? null,
    })
    res.status(200).json(result)
  } catch (error) {
    if (error instanceof OpsOrderError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }
    console.error("[ops/orders/move] failed", error)
    res.status(500).json({ error: "Could not move that order." })
  }
}
