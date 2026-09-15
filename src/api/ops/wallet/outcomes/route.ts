import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { getPincodeOutcomes } from "../../../../services/wallet/outcomes"
import type { Brand } from "../../../../services/wallet/ledger"

/**
 * GET /ops/wallet/outcomes?brand=…&pincode=… — what the rewards in one pincode have done.
 *
 * Settings without outcomes is half a panel: the numbers being edited elsewhere only mean something
 * next to what the last set of them cost and returned. GET only — this reports.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const q = req.query as Record<string, unknown>
  const brand = String(q.brand ?? "") as Brand
  const pincode = String(q.pincode ?? "")

  if (brand !== "crossfriend" && brand !== "pranajiva") {
    res.status(400).json({ error: "Unknown brand." })
    return
  }
  if (!/^[1-9][0-9]{5}$/.test(pincode)) {
    res.status(400).json({ error: "A six-digit pincode is required." })
    return
  }

  try {
    res.status(200).json(await getPincodeOutcomes(brand, pincode))
  } catch (error) {
    console.error("[ops/wallet/outcomes] failed", error)
    res.status(500).json({ error: "Could not read the outcomes." })
  }
}
