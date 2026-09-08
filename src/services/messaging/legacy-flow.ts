/**
 * Rollback path: the pre-SendOTP implementation, reachable without a code change.
 *
 * Set MSG91_OTP_MODE=legacy and the routes go back to generating the code here, storing an HMAC of
 * it in Redis, and using MSG91's Flow API purely as an SMS transport. That path still requires
 * OTP_HASH_SECRET; SendOTP does not.
 *
 * ── Why an adapter rather than branching inside the routes ─────────────────────────────────────
 * The two implementations have genuinely different shapes — one issues then sends and can leave an
 * orphaned code if delivery fails, the other delegates entirely — and interleaving them in the
 * route bodies would produce a control flow where it is hard to be sure the fail-closed rule holds
 * on every branch. Keeping the old behaviour behind one function per operation means the live path
 * reads as if the legacy path did not exist.
 *
 * ── This file is scheduled for deletion ────────────────────────────────────────────────────────
 * Once SendOTP is verified in production, delete this file, ./otp.ts and ./msg91.ts together, and
 * drop OTP_HASH_SECRET. Until then the old code stays compiled and reachable, which is the whole
 * value of having a rollback.
 */

import type { FlowConfig } from "./config"
import type { OtpFailureKind } from "./msg91-otp"
import { sendSms } from "./msg91"
import { issueOtp, rollbackIssue, verifyOtp as verifyOtpLocally } from "./otp"

/**
 * Read once at module load rather than per request, so the mode cannot change halfway through a
 * customer's sign-in — sending under one implementation and verifying under the other would fail
 * for reasons nobody could reconstruct from the logs.
 */
export const LEGACY_MODE = process.env.MSG91_OTP_MODE === "legacy"

if (LEGACY_MODE) {
  console.warn(
    "[messaging] MSG91_OTP_MODE=legacy — using the pre-SendOTP Flow API path. " +
      "OTP_HASH_SECRET must be set. This path is deprecated and due for removal."
  )
}

/**
 * Shaped to match Msg91Result's optional fields so the send route can treat either path uniformly.
 *
 * requestId is always absent here — under the legacy path MSG91's Flow API is a fire-and-forget
 * transport with no OTP session to reference — but declaring it keeps the attempt log's call site
 * free of a branch that would exist only to satisfy the compiler.
 */
export interface LegacyResult {
  ok: boolean
  error?: string
  requestId?: string | null
  /**
   * Always absent on this path — the legacy verifier compares locally and has no provider verdict
   * to classify. Declared so the verify route can read `.kind` without branching on which
   * implementation produced the result; undefined falls through to the same generic handling a
   * wrong code gets, which is correct for a local mismatch.
   */
  kind?: OtpFailureKind
}

export async function legacySend(config: FlowConfig, mobile: string): Promise<LegacyResult> {
  const issued = await issueOtp(config, mobile)
  if (!issued.ok) return { ok: false, error: issued.error }

  const sent = await sendSms({
    mobile,
    providerTemplateId: config.template!.providerTemplateId,
    variables: { otp: issued.code! },
  })

  if (!sent.ok) {
    // Drop the code we stored but never delivered, so a resend does not collide with a code the
    // customer does not have.
    await rollbackIssue(config, mobile)
    return { ok: false, error: sent.error }
  }

  return { ok: true }
}

export async function legacyVerify(
  config: FlowConfig,
  mobile: string,
  otp: string
): Promise<LegacyResult> {
  const result = await verifyOtpLocally(config, mobile, otp)
  return { ok: result.ok, error: result.error }
}
