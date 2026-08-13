import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { syncBakerProductVisibility } from "../../../../../services/baker-portal/baker-visibility"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/bakers/:id/visibility
 *
 * Re-projects a bakery's products onto Medusa after its `is_active` or `is_public` flags change.
 * Called by OPS immediately after it saves a baker, never by a browser.
 *
 * Lives here rather than in OPS for the same reason the activation endpoint does: the projection has
 * to go through Medusa's productService so its hooks, events and search indexing fire, and OPS talks
 * to the database directly with no Medusa container to resolve. Reimplementing it there as raw SQL
 * would work until the day something started listening for product updates.
 *
 * Idempotent — safe to call after every save, and safe to retry. It compares the desired projection
 * against the live one and writes only the difference, so a call that changes nothing costs one
 * indexed read per product.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    return res.status(401).json({ error: "Unauthorized." })
  }

  const bakerId = String(req.params.id || "")
  if (!bakerId) {
    return res.status(400).json({ error: "Baker id is required." })
  }

  try {
    const result = await syncBakerProductVisibility(req, bakerId)
    return res.status(200).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"

    if (message === "Baker not found") {
      return res.status(404).json({ error: "That bakery no longer exists." })
    }
    if (message.includes("sales channel is missing")) {
      // Environment problem, not a data problem — worth saying plainly so it is not mistaken for
      // a broken baker record.
      return res.status(500).json({ error: message })
    }

    console.error("[API /ops/bakers/:id/visibility] Error:", error)
    return res.status(500).json({ error: "Couldn't update product visibility for this bakery." })
  }
}
