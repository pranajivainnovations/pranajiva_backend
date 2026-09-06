import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getFlowConfig } from "../../../../../services/messaging/config"
import { verifyOtp } from "../../../../../services/messaging/otp"

/**
 * POST /store/crossfriend/otp/verify
 *
 * Checks a submitted code against the one issued for this number, and consumes it.
 *
 * This route does NOT log the customer in. It answers one question — was this the right code — and
 * the storefront turns a true into a Medusa session, because the session cookie has to be set on
 * the storefront's own origin. The code is deleted on success, so the answer cannot be obtained
 * twice: a caller who verifies directly against this route burns the code and the storefront's
 * subsequent attempt fails, which is the correct outcome rather than a bypass.
 */

const ALLOWED_FLOWS = new Set(["ai_studio_login"])

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as { mobile?: string; otp?: string; flow?: string }
  const mobile = String(body.mobile ?? "").trim()
  const otp = String(body.otp ?? "").trim()
  const flowKey = String(body.flow ?? "ai_studio_login")

  if (!ALLOWED_FLOWS.has(flowKey)) {
    res.status(400).json({ error: "Unknown sign-in flow." })
    return
  }

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    res.status(400).json({ error: "Invalid mobile number" })
    return
  }

  try {
    const config = await getFlowConfig(flowKey)
    if (!config) {
      console.error(`[otp/verify] flow ${flowKey} is not configured`)
      res.status(503).json({ error: "Sign-in by SMS is temporarily unavailable. Please try again later." })
      return
    }

    /**
     * Verification intentionally does not check is_enabled or the template assignment.
     *
     * If an operator switches the flow off in the thirty seconds between a customer receiving their
     * code and typing it, the honest behaviour is to honour the code that was genuinely sent. The
     * switch stops new codes going out; it should not strand someone mid-login.
     */
    const result = await verifyOtp(config, mobile, otp)
    if (!result.ok) {
      res.status(400).json({ error: result.error })
      return
    }

    res.status(200).json({ verified: true })
  } catch (error) {
    console.error("[otp/verify] failed", error)
    res.status(500).json({ error: "Something went wrong. Please try again." })
  }
}
