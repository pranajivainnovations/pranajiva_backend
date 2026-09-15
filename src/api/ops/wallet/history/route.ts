import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { getAuditTrail, type Mechanic } from "../../../../services/wallet/reward-config"
import type { Brand } from "../../../../services/wallet/ledger"

const MECHANICS: Mechanic[] = ["economics", "joining_cash", "referral", "cashback"]

/**
 * GET /ops/wallet/history?brand=…&mechanic=…&pincode=… — who changed what, and when.
 *
 * Every version of the reward configuration is permanent and the one it replaced is still readable,
 * so this endpoint invents nothing: it reads what the table already records and adds the difference
 * between consecutive versions, which is the part a person actually wants.
 *
 * GET only. An audit trail writable through the same door it is read from is not one.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const q = req.query as Record<string, unknown>
  const brand = String(q.brand ?? "") as Brand
  const mechanic = String(q.mechanic ?? "") as Mechanic
  const pincode = q.pincode ? String(q.pincode) : null

  if (brand !== "crossfriend" && brand !== "pranajiva") {
    res.status(400).json({ error: "Unknown brand." })
    return
  }
  if (!MECHANICS.includes(mechanic)) {
    res.status(400).json({ error: "Unknown mechanic." })
    return
  }

  try {
    res.status(200).json({ entries: await getAuditTrail(brand, pincode, mechanic) })
  } catch (error) {
    console.error("[ops/wallet/history] failed", error)
    res.status(500).json({ error: "Could not read the history." })
  }
}
