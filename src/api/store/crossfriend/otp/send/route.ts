import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { flowBlockedReason, getFlowConfig } from "../../../../../services/messaging/config"
import { isProviderConfigured, sendSms } from "../../../../../services/messaging/msg91"
import { issueOtp, rollbackIssue } from "../../../../../services/messaging/otp"

/**
 * POST /store/crossfriend/otp/send
 *
 * Issues a one-time password for a configured flow and delivers it over SMS.
 *
 * The storefront proxies to this rather than calling MSG91 itself. Two reasons: the OTP has to be
 * stored somewhere between send and verify and Redis lives here, and the provider auth key belongs
 * with the other backend credentials rather than in a Next.js runtime environment.
 *
 * ── What this route deliberately does not tell the caller ──────────────────────────────────────
 * Never the code, in any environment. The mock this replaces logged it to the console, which is
 * survivable in development and a full account-takeover path the first time log output is
 * aggregated anywhere. Never whether the number is a known customer either — that would turn the
 * sign-in form into a way to enumerate who has an account.
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
      /**
       * 503 with a generic message. The operator-facing reason is logged, not returned: "no
       * template is assigned to this flow" describes our internal configuration to anybody who
       * probes the endpoint, and the customer can do nothing with it either way.
       */
      console.error(`[otp/send] flow ${flowKey} unavailable: ${blocked}`)
      res.status(503).json({ error: "Sign-in by SMS is temporarily unavailable. Please try again later." })
      return
    }

    if (!isProviderConfigured()) {
      console.error("[otp/send] MSG91_AUTH_KEY is not set")
      res.status(503).json({ error: "Sign-in by SMS is temporarily unavailable. Please try again later." })
      return
    }

    const issued = await issueOtp(config, mobile)
    if (!issued.ok) {
      // 429 rather than 400: this is a rate limit, and the storefront shows the wait to the user.
      res.status(429).json({ error: issued.error, retryAfterSeconds: issued.retryAfterSeconds })
      return
    }

    /**
     * The variable name has to match the placeholder registered in the DLT template. MSG91 maps
     * flow variables by name, and a mismatch is not an error — it substitutes an empty string and
     * cheerfully delivers "Your CrossFriend verification code is ." So this name and the DLT
     * registration have to be changed together.
     */
    const sent = await sendSms({
      mobile,
      providerTemplateId: config.template.providerTemplateId,
      variables: { otp: issued.code },
    })

    if (!sent.ok) {
      // The customer never received this code, so release the cooldown and daily slot they paid
      // for. Without this, a provider outage locks a number out for the rest of the day.
      await rollbackIssue(config, mobile)
      console.error(`[otp/send] delivery failed for flow ${flowKey}: ${sent.error}`)
      res.status(502).json({ error: "We could not send the code right now. Please try again." })
      return
    }

    res.status(200).json({
      success: true,
      expiresInSeconds: issued.expiresInSeconds,
      resendAfterSeconds: config.resendCooldownSeconds,
      otpLength: config.otpLength,
    })
  } catch (error) {
    console.error("[otp/send] failed", error)
    res.status(500).json({ error: "Something went wrong. Please try again." })
  }
}
