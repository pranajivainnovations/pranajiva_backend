import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getFlowConfig } from "../../../../../services/messaging/config"
import { LEGACY_MODE, legacyVerify } from "../../../../../services/messaging/legacy-flow"
import { verifyOtp, type OtpFailureKind } from "../../../../../services/messaging/msg91-otp"
import { recordVerify } from "../../../../../services/messaging/otp-log"
import {
  attemptsRemaining,
  clearAttempts,
  countAttempt,
} from "../../../../../services/messaging/rate-limit"

/**
 * POST /store/crossfriend/otp/verify
 *
 * Asks MSG91 whether a submitted code is the one it issued.
 *
 * This route does NOT log the customer in. It answers one question — was this the right code — and
 * the storefront turns a true into a Medusa session, because the session cookie has to be set on
 * the storefront's own origin.
 *
 * ── Fail-closed ────────────────────────────────────────────────────────────────────────────────
 * `verified: true` is returned from exactly one place in this file, reached only when MSG91
 * answered `type: "success"`. A timeout, a non-2xx, an unparseable body, a missing field or an
 * unrecognised response all fall through to the failure branch. That property is what the previous
 * mock lacked, and it is worth more than any convenience: the cost of a wrong classification here
 * is a customer seeing a vague error, while the cost of a permissive default is anyone signing in
 * as anyone.
 *
 * ── Availability trade ─────────────────────────────────────────────────────────────────────────
 * Verification now depends on MSG91 being reachable. Under the old implementation an outage
 * blocked new sign-ins but let codes already sent be verified locally; now it blocks both. That is
 * the accepted cost of MSG91 owning the code, and it is why the error below says "right now".
 */

const ALLOWED_FLOWS = new Set(["ai_studio_login"])

/** Customer-facing text per failure kind. The provider's own wording is logged, never shown. */
function messageFor(kind: OtpFailureKind | undefined, remaining: number): string {
  switch (kind) {
    case "expired":
      return "That code has expired. Please request a new one."
    case "already_verified":
      return "That code has already been used. Please request a new one."
    case "provider_limit":
      return "Too many attempts. Please request a new code."
    case "unavailable":
      return "We could not check that code right now. Please try again."
    case "wrong":
    case "unknown":
    default:
      return remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
        : "Incorrect code. Please request a new one."
  }
}

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
      res
        .status(503)
        .json({ error: "Sign-in by SMS is temporarily unavailable. Please try again later." })
      return
    }

    /**
     * Verification intentionally does not check is_enabled or the template assignment.
     *
     * If an operator switches the flow off in the thirty seconds between a customer receiving their
     * code and typing it, the honest behaviour is to honour the code that was genuinely sent. The
     * switch stops new codes going out; it should not strand someone mid-login.
     */

    // Shape check first, so a malformed submission never costs the customer an attempt and never
    // reaches MSG91 as a billable request.
    if (!new RegExp(`^\\d{${config.otpLength}}$`).test(otp)) {
      res
        .status(400)
        .json({ error: `Enter the ${config.otpLength}-digit code sent to your mobile.` })
      return
    }

    /**
     * Our own attempt cap, checked before the provider is called.
     *
     * MSG91 applies limits of its own, but they are undocumented, invisible to us and not tunable
     * per flow — so a guessing attack is refused here rather than forwarded one paid request at a
     * time. The window matches the code's configured lifetime, so an exhausted budget never
     * outlives the code it was guessing at.
     */
    const attempt = await countAttempt(flowKey, mobile, config.maxAttempts, config.otpTtlSeconds)
    if (!attempt.ok) {
      res.status(429).json({ error: attempt.error })
      return
    }

    const result = LEGACY_MODE
      ? await legacyVerify(config, mobile, otp)
      : await verifyOtp(mobile, otp)

    if (!result.ok) {
      console.error(`[otp/verify] rejected for flow ${flowKey}: ${result.error}`)
      await recordVerify({ mobile, flowKey, ok: false, failureKind: result.kind ?? null })
      const remaining = await attemptsRemaining(flowKey, mobile, config.maxAttempts)
      const kind = "kind" in result ? (result.kind as OtpFailureKind | undefined) : undefined
      // 502 when the provider itself was unreachable — that is our problem, not a wrong code, and
      // the status should not tell the customer they typed it incorrectly.
      res.status(kind === "unavailable" ? 502 : 400).json({ error: messageFor(kind, remaining) })
      return
    }

    // Reached only on an explicit MSG91 success.
    await recordVerify({ mobile, flowKey, ok: true })
    await clearAttempts(flowKey, mobile)
    res.status(200).json({ verified: true })
  } catch (error) {
    console.error("[otp/verify] failed", error)
    res.status(500).json({ error: "Something went wrong. Please try again." })
  }
}
