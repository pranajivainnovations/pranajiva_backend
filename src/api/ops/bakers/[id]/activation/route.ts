import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { issueActivation } from "../../../../../services/baker-portal/activation"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/bakers/:id/activation
 *
 * Issues (or re-issues) a baker's activation invite. Called by OPS, never by a browser.
 *
 * Returns the raw token EXACTLY ONCE. Only its SHA-256 hash is stored, so there is no endpoint —
 * here or anywhere — that can retrieve it again. If an OPS user loses the link before sending it,
 * the answer is to re-issue, which revokes the previous one. That is a deliberate trade: an invite
 * that could be re-read from the database would be an invite an attacker could re-read too.
 *
 * Re-issuing is safe and expected. issueActivation revokes any live token for that baker inside the
 * same transaction, so an old link sitting in someone's inbox stops working the moment a new one is
 * generated — there is never more than one valid invite per bakery.
 *
 * Refuses an already-claimed bakery. Re-inviting one would either strand the existing account or
 * create a second owner, and the partial unique index on baker_users would reject the latter
 * anyway; failing here with a clear message beats failing later with a constraint violation.
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
    const body = (req.body ?? {}) as { opsUserId?: string }

    const activation = await issueActivation(bakerId, body.opsUserId ?? null)

    return res.status(201).json({
      // The caller must surface this immediately and never store it.
      token: activation.rawToken,
      expiresAt: activation.expiresAt,
      bakerPublicId: activation.bakerPublicId,
      bakerName: activation.bakerName,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"

    // issueActivation throws these deliberately, and they are useful to an OPS user as-is.
    if (message === "Baker not found") {
      return res.status(404).json({ error: "That bakery no longer exists." })
    }
    if (message === "Baker is inactive") {
      return res.status(409).json({ error: "This bakery is inactive — reactivate it before inviting." })
    }
    if (message.includes("already claimed")) {
      return res.status(409).json({ error: "This bakery has already set up its account." })
    }

    console.error("[API /ops/bakers/:id/activation] Error:", error)
    return res.status(500).json({ error: "Couldn't create the invite. Please try again." })
  }
}
