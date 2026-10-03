import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { assignBaker, OpsOrderError } from "../../../../services/orders/ops"

/**
 * POST /ops/orders/assign — give an order's items to a baker.
 *
 * Omitting `itemIds` assigns every item on the order, which is what ops does nearly every time. The
 * per-item form exists because a cart can hold a custom cake and a ready-to-deliver box that come
 * from different kitchens, and baker_id lives on the item for exactly that reason.
 *
 * `opsUserId` is required. Assignment is the moment an order becomes somebody's work, and an
 * unattributed one is impossible to explain later when a baker says they never got it.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    orderId?: string
    bakerId?: string
    itemIds?: string[]
    opsUserId?: string
  }

  if (!body.orderId || !body.bakerId) {
    res.status(400).json({ error: "orderId and bakerId are required." })
    return
  }
  if (!body.opsUserId) {
    res.status(400).json({ error: "opsUserId is required — every assignment is attributed." })
    return
  }

  try {
    const result = await assignBaker({
      orderId: body.orderId,
      bakerId: body.bakerId,
      itemIds: body.itemIds,
      opsUserId: body.opsUserId,
    })
    res.status(200).json(result)
  } catch (error) {
    if (error instanceof OpsOrderError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }
    console.error("[ops/orders/assign] failed", error)
    res.status(500).json({ error: "Could not assign that order." })
  }
}
