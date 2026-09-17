import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { issueCustomerSession } from "../crossfriend/customer-session"
import { flowBlockedReason, getFlowConfig, resolveLoginFlow } from "./config"
import { issueSignupBonus } from "../wallet/signup-bonus"
import { LEGACY_MODE, legacySend, legacyVerify } from "./legacy-flow"
import { isProviderConfigured, sendOtp, verifyOtp, type OtpFailureKind } from "./msg91-otp"
import { recordSend, recordVerify } from "./otp-log"
import { maybePurgeAttemptLog } from "./purge-throttle"
import {
  attemptsRemaining,
  clearAttempts,
  countAttempt,
  releaseSend,
  reserveSend,
} from "./rate-limit"

/**
 * The mobile OTP sign-in handlers, shared by every path they are mounted on.
 *
 * ── Why these live here rather than in the route files ─────────────────────────────────────────
 * They are served from two paths: the brand-neutral `/store/otp/*`, and `/store/crossfriend/otp/*`,
 * which the deployed CrossFriend storefront and the OPS setup checklist both still call. Two mounts
 * of one implementation is the only arrangement where the alias cannot drift from the canonical
 * route — and drift here would not be a cosmetic difference, it would be two different sets of rate
 * limits and attempt caps on the same sign-in.
 *
 * Medusa's file-based router only loads files named `route.ts`, so this could have sat beside them
 * under `src/api`. It sits with the rest of the messaging code instead, because that is where every
 * function it calls already lives.
 */

/**
 * POST — ask MSG91 to generate, store and deliver a one-time password.
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
export async function handleOtpSend(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as { mobile?: string; flow?: string; brand?: string }
  const mobile = String(body.mobile ?? "").trim()

  /**
   * Resolved against a closed set, so a caller can never name an arbitrary flow and drive an
   * unrelated template's SMS. The 400 on an unknown value is load-bearing beyond validation: the OPS
   * setup checklist probes this route with a flow key that cannot exist and reads 400 as "deployed"
   * against 404 as "not deployed". Answering anything else there would turn that signal off silently.
   */
  const resolved = resolveLoginFlow(body)
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error })
    return
  }
  const { flowKey } = resolved

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

    /**
     * Keyed by flow, so each brand carries its own cooldown and daily budget for the same number.
     * That is the intended reading: they are different messages, from different DLT headers, and an
     * operator tuning one brand's abuse limits should not silently move the other's.
     */
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

    /**
     * Recorded for both outcomes, and awaited rather than fired and forgotten.
     *
     * A failed send is the row support most needs — it is the customer who is sitting there having
     * received nothing — so losing it to a race with the response would defeat the purpose. The
     * call cannot throw: every function in otp-log swallows its own errors.
     */
    await recordSend({
      mobile,
      flowKey,
      ok: sent.ok,
      senderHeader: config.template.senderHeader,
      providerTemplateId: config.template.providerTemplateId,
      providerRequestId: sent.requestId ?? null,
      providerError: sent.error ?? null,
    })

    // Retention sweep, throttled to roughly once a day and deliberately not awaited — a customer
    // waiting on an OTP should not also wait on a DELETE.
    void maybePurgeAttemptLog()

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

/**
 * POST — ask MSG91 whether a submitted code is the one it issued, and mint the session.
 *
 * ── Why the session is minted here and not by the storefront ───────────────────────────────────
 * It used to answer only "was this the right code", and the storefront turned a true into a session
 * by logging in with a password derived from the mobile number and a shared salt. That made the salt
 * a master key — anyone holding it could authenticate as any customer straight against
 * `POST /store/auth`, never requesting a code, never receiving an SMS, never touching the attempt
 * limits enforced a few lines below. The controls on this route guarded one door; the derived
 * password was a second one standing open beside it.
 *
 * Issuing the token from the same place that verified the code closes that: there is no longer a
 * password anybody can compute. The storefront's only remaining job is to put the token in a cookie,
 * and a future mobile app can hold the same token without one.
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
export async function handleOtpVerify(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as {
    mobile?: string
    otp?: string
    flow?: string
    brand?: string
    /* What the visitor typed into the storefront before signing in, if anything. Declared, never
       verified — see issueSignupBonus for what it is and is not allowed to decide. */
    pincode?: string | null
  }
  const mobile = String(body.mobile ?? "").trim()
  const otp = String(body.otp ?? "").trim()

  const resolved = resolveLoginFlow(body)
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error })
    return
  }
  const { flowKey } = resolved

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

    /**
     * The session, issued only past the verification above.
     *
     * Deliberately NOT passed the brand. One mobile must resolve to one customer row whichever
     * storefront it signs in from — that shared row is the whole basis of the cross-brand wallet —
     * so the brand must not reach the point where a customer is minted, or it would become a way to
     * create a second account for the same person. Making that guarantee hold for the customers who
     * already exist is its own piece of work (GS-1.3).
     *
     * A failure here is deliberately not reported as a bad code — the customer typed the right one,
     * and telling them otherwise would send them to request another that would fail the same way.
     */
    try {
      const session = await issueCustomerSession(req, mobile)

      /**
       * A joining bonus, if a campaign is running and this is a new account.
       *
       * ── Why a failure here cannot fail the sign-in ─────────────────────────────────────────────
       * The session already exists by this point. A customer locked out of their own account because
       * a promotional grant threw would be a catastrophic trade for a feature whose entire purpose is
       * to make them feel welcome. Everything is caught; a missed bonus can be granted by hand, and
       * the grant path is safe to run again because a unique index makes the second one a no-op.
       *
       * ── Why every sign-in and not only a new account ───────────────────────────────────────────
       * It was new accounts only, which quietly made the offer unclaimable for the people most likely
       * to miss it: somebody who skipped the pincode prompt, signed in with no area, and told us where
       * they were afterwards. The rule is "no pincode, no bonus YET" — so every sign-in is another
       * chance to settle it, and so is the moment they set a pincode while signed in.
       *
       * Safe to run on every sign-in because the unique index grants once. The fortieth sign-in writes
       * nothing and costs one indexed read.
       */
      {
        try {
          const outcome = await issueSignupBonus({
            customerId: session.customerId,
            brand: resolved.brand,
            pincode: typeof body.pincode === "string" ? body.pincode : null,
          })
          if (outcome.granted) {
            console.log(
              `[otp/verify] joining bonus of ₹${(outcome.amountPaise / 100).toFixed(2)} ` +
                `to ${session.customerId}`
            )
          }
        } catch (error) {
          console.error("[otp/verify] joining bonus failed", error)
        }
      }

      res.status(200).json({
        verified: true,
        token: session.token,
        isNewUser: session.isNewUser,
      })
    } catch (error) {
      console.error("[otp/verify] verified the code but could not issue a session", error)
      res.status(500).json({ error: "Signed in, but something went wrong. Please try again." })
    }
  } catch (error) {
    console.error("[otp/verify] failed", error)
    res.status(500).json({ error: "Something went wrong. Please try again." })
  }
}
