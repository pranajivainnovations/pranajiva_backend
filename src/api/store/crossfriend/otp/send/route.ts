import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { flowBlockedReason, getFlowConfig } from "../../../../../services/messaging/config"
import { isProviderConfigured, sendOtp } from "../../../../../services/messaging/msg91-otp"
import { releaseSend, reserveSend } from "../../../../../services/messaging/rate-limit"
import { LEGACY_MODE, legacySend } from "../../../../../services/messaging/legacy-flow"

/**
 * POST /store/crossfriend/otp/send
 *
 * Asks MSG91 to generate, store and deliver a one-time password.
 *
 * ── Who owns the code ──────────────────────────────────────────────────────────────────────────
 * MSG91 does. We never see it, never store it, and cannot read it back — which is the point of
 * moving to SendOTP. The previous implementation generated the code here and used MSG91 only as an
 * SMS pipe; it is still present behind MSG91_OTP_MODE=legacy as a rollback path.
 *
 * ── What this route deliberately does not tell the caller ──────────────────────────────────────
 * Never the code, in any environment. Never whether the number belongs to an existing customer,
 * which would turn the sign-in form into a way to enumerate who has an account. And never the
 * internal reason a flow is unavailable — that describes our configuration to anyone who probes.
 */

/** Only flows this route is willing to serve, so a caller cannot drive an unrelated flow's SMS. */
const ALLOWED_FLOWS = new Set(["ai_studio_login"])

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as { mobile?: string; flow?: string }
  const mobile = String(body.mobile ?? "").trim()
  const flowKey = String(body.flow ?? "ai_studio_login")

  if (!ALLOWED_FLOWS.has(flowKey)) {
    res.status(400).json({ error: "Unknown sign-in flow." })
    return
  }

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number" })
    return
  }

  try {
    const config = await getFlowConfig(flowKey)
    const blocked = flowBlockedReason(config)
    if (blocked || !config?.template) {
      console.error(`[otp/send] flow ${flowKey} unavailable: ${blocked}`)
      res
        .status(503)
        .json({ error: "Sign-in by SMS is temporarily unavailable. Please try again later." })
      return
    }

    if (!isProviderConfigured()) {
      console.error("[otp/send] MSG91_AUTH_KEY is not set")
      res
        .status(503)
        .json({ error: "Sign-in by SMS is temporarily unavailable. Please try again later." })
      return
    }

    const limits = {
      flowKey,
      resendCooldownSeconds: config.resendCooldownSeconds,
      dailySendLimit: config.dailySendLimit,
    }

    // Claimed before the provider is called, so a rejected request never reaches MSG91 and never
    // costs a billable send.
    const reserved = await reserveSend(limits, mobile)
    if (!reserved.ok) {
      res.status(429).json({ error: reserved.error, retryAfterSeconds: reserved.retryAfterSeconds })
      return
    }

    /**
     * Seconds in our configuration, MINUTES on the wire.
     *
     * MSG91's otp_expiry is in minutes. Passing our stored 600 unconverted would issue a code valid
     * for ten hours — a change no test would catch, since the code still arrives and still works.
     * Math.max(1, …) keeps a sub-minute configuration from rounding down to zero, which MSG91 would
     * reject outright.
     */
    const otpExpiryMinutes = Math.max(1, Math.round(config.otpTtlSeconds / 60))

    const sent = LEGACY_MODE
      ? await legacySend(config, mobile)
      : await sendOtp({
          mobile,
          templateId: config.template.providerTemplateId,
          otpLength: config.otpLength,
          otpExpiryMinutes,
        })

    if (!sent.ok) {
      // The customer never received a code, so give back the cooldown and daily slot they spent.
      await releaseSend(limits, mobile)
      console.error(`[otp/send] delivery failed for flow ${flowKey}: ${sent.error}`)
      res.status(502).json({ error: "We could not send the code right now. Please try again." })
      return
    }

    res.status(200).json({
      success: true,
      expiresInSeconds: config.otpTtlSeconds,
      resendAfterSeconds: config.resendCooldownSeconds,
      otpLength: config.otpLength,
    })
  } catch (error) {
    console.error("[otp/send] failed", error)
    res.status(500).json({ error: "Something went wrong. Please try again." })
  }
}
