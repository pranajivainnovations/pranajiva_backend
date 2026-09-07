import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getFlowConfig } from "../../../../services/messaging/config"
import { retryOtp, sendOtp, verifyOtp } from "../../../../services/messaging/msg91-otp"
import { releaseSend, reserveSend } from "../../../../services/messaging/rate-limit"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/messaging/test-otp
 *
 * Sends, verifies or resends a real OTP and returns MSG91's unedited answer. Called by the OPS
 * messaging screen, never by a browser.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────────
 * The customer-facing routes deliberately hide MSG91's error text: "Sign-in is temporarily
 * unavailable" is the right thing to tell a customer and an attacker, and the wrong thing to tell
 * the operator who has just typed a template ID. Without somewhere to see the provider's actual
 * words, diagnosing an unapproved template or a rejected header means reading container logs on a
 * production host. This endpoint is that somewhere, and it is why the raw field exists at all.
 *
 * ── What it deliberately does not do ───────────────────────────────────────────────────────────
 * It never creates or logs in a Medusa customer. A successful verify here proves the SMS path
 * works and nothing more — making it also mint a session would turn an operator diagnostic into a
 * way to obtain a customer's cookie, which is a much larger thing than a test button.
 *
 * It also does not bypass the rate limiter. A test button that sends real, chargeable SMS is still
 * a way to spend the account's balance, and exempting it would leave the one caller most likely to
 * be clicked repeatedly as the one caller with no ceiling.
 */

const FLOW_KEY = "ai_studio_login"

type Action = "send" | "verify" | "retry"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    return res.status(401).json({ error: "Unauthorized." })
  }

  const body = (req.body ?? {}) as { mobile?: string; action?: string; otp?: string }
  const mobile = String(body.mobile ?? "").trim()
  const action = String(body.action ?? "send") as Action

  if (!["send", "verify", "retry"].includes(action)) {
    return res.status(400).json({ error: "action must be send, verify or retry." })
  }

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." })
  }

  try {
    const config = await getFlowConfig(FLOW_KEY)
    if (!config?.template) {
      return res.status(400).json({
        error: "No SMS template is assigned to the AI Studio sign-in flow. Assign one first.",
      })
    }

    /**
     * is_enabled is NOT required here, on purpose.
     *
     * The whole point of a test panel is to prove a configuration works before switching it on for
     * customers. Requiring the flow to be live first would force the operator to expose a broken
     * setup to real users in order to find out whether it is broken.
     */
    if (!config.template.providerTemplateId) {
      return res
        .status(400)
        .json({ error: "That template has no MSG91 template ID, so nothing can be sent." })
    }

    const otpExpiryMinutes = Math.max(1, Math.round(config.otpTtlSeconds / 60))
    const limits = {
      flowKey: FLOW_KEY,
      resendCooldownSeconds: config.resendCooldownSeconds,
      dailySendLimit: config.dailySendLimit,
    }

    if (action === "verify") {
      const otp = String(body.otp ?? "").trim()
      if (!/^\d{4,9}$/.test(otp)) {
        return res.status(400).json({ error: "Enter the code you received." })
      }

      const result = await verifyOtp(mobile, otp)
      return res.status(200).json({
        action,
        ok: result.ok,
        raw: result.raw ?? null,
        kind: result.kind ?? null,
        // Restates what a success here does and does not mean, because "verified" on an ops screen
        // invites the reading that somebody is now logged in.
        note: result.ok
          ? "MSG91 accepted the code. No customer session was created — this is a transport test only."
          : null,
      })
    }

    // send and retry both consume a slot: each one costs a message.
    const reserved = await reserveSend(limits, mobile)
    if (!reserved.ok) {
      return res.status(429).json({
        error: reserved.error,
        retryAfterSeconds: reserved.retryAfterSeconds ?? null,
      })
    }

    const result =
      action === "retry"
        ? await retryOtp(mobile)
        : await sendOtp({
            mobile,
            templateId: config.template.providerTemplateId,
            otpLength: config.otpLength,
            otpExpiryMinutes,
          })

    if (!result.ok) {
      await releaseSend(limits, mobile)
    }

    return res.status(200).json({
      action,
      ok: result.ok,
      raw: result.raw ?? null,
      kind: result.kind ?? null,
      sentConfig: {
        senderHeader: config.template.senderHeader,
        dltTemplateId: config.template.dltTemplateId,
        providerTemplateId: config.template.providerTemplateId,
        otpLength: config.otpLength,
        otpExpiryMinutes,
        /**
         * Surfaced because it is the mismatch most likely to be live right now: the approved SMS
         * text promises ten minutes, and otp_expiry is derived from a database column that is easy
         * to leave at its seeded 300. Showing both lets the operator catch it without arithmetic.
         */
        ttlSecondsConfigured: config.otpTtlSeconds,
      },
    })
  } catch (error) {
    console.error("[ops/messaging/test-otp] failed", error)
    return res.status(500).json({ error: "The test request failed. Check the backend logs." })
  }
}
