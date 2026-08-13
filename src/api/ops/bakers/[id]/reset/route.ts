import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import {
  resetBakerAccess,
  resetBakerData,
  assertBakerDataDeletable,
} from "../../../../../services/baker-portal/reset"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/bakers/:id/reset
 *
 * Body: { access?: boolean, data?: boolean, opsUserId?: string }
 *
 * Undoes a baker's onboarding. Two independent switches rather than one destructive button, because
 * the common case — a bakery claimed by the wrong person, or one onboarded to test with — needs only
 * `access`, and fusing them would make the routine operation carry the irreversible one's risk.
 *
 * Order matters when both are asked for: access first, so the accounts are already locked out before
 * the catalogue is touched. The reverse would leave a live session able to watch its own products
 * disappear, or create new ones midway through.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    return res.status(401).json({ error: "Unauthorized." })
  }

  const bakerId = String(req.params.id || "")
  if (!bakerId) {
    return res.status(400).json({ error: "Baker id is required." })
  }

  const body = (req.body ?? {}) as { access?: boolean; data?: boolean; opsUserId?: string }
  const opsUserId = body.opsUserId ?? null

  if (!body.access && !body.data) {
    return res.status(400).json({ error: "Choose what to reset." })
  }

  try {
    // Checked before anything is written, so a refusal means nothing happened at all rather than
    // leaving the access half already applied.
    if (body.data) {
      await assertBakerDataDeletable(bakerId)
    }

    const result: Record<string, unknown> = {}

    if (body.access) {
      result.access = await resetBakerAccess(bakerId, opsUserId)
    }
    if (body.data) {
      result.data = await resetBakerData(req, bakerId, opsUserId)
    }

    return res.status(200).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"

    if (message === "Baker not found") {
      return res.status(404).json({ error: "That bakery no longer exists." })
    }
    if (message.startsWith("REFUSED:")) {
      // 409: the request is well-formed, it conflicts with the bakery's order history.
      return res.status(409).json({ error: message.slice("REFUSED:".length) })
    }

    console.error("[API /ops/bakers/:id/reset] Error:", error)
    return res.status(500).json({ error: "Couldn't reset this bakery. Please try again." })
  }
}
