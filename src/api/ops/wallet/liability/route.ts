import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { getLiabilityReport } from "../../../../services/wallet/liability"

/**
 * GET /ops/wallet/liability — what we currently owe customers in credit.
 *
 * Called by OPS, never by a browser: it is the whole business's exposure broken down by brand, and
 * a customer has no reason to be able to read it. Same service-key check as the other /ops routes,
 * so there is one thing to rotate rather than a second scheme to remember.
 *
 * GET only. This endpoint reports; nothing here can grant, redeem or expire anything, and there is
 * no handler exported that could.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  try {
    const report = await getLiabilityReport()

    res.status(200).json({
      ...report,
      /* Rupees alongside paise, because every consumer of this would otherwise divide by 100 in its
         own template and one of them would eventually forget. Paise stays authoritative. */
      outstandingRupees: report.outstandingPaise / 100,
      awaitingSweepRupees: report.awaitingSweepPaise / 100,
      debtRupees: report.debtPaise / 100,
    })
  } catch (error) {
    console.error("[ops/wallet/liability] failed", error)
    res.status(500).json({ error: "Could not build the liability report." })
  }
}
