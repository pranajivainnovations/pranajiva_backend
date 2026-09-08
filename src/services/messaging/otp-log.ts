/**
 * Records OTP sign-in attempts for support.
 *
 * ── Every function here is fail-soft, and that is the most important thing about this file ──────
 * Logging must never break the thing it observes. If the database is slow, full, or the table has
 * not been migrated yet, a customer trying to sign in should still sign in — so every call is
 * wrapped, errors are logged and swallowed, and no caller is given anything it could accidentally
 * treat as a failure of the OTP itself. A sign-in that breaks because its audit trail broke is a
 * worse outcome than a missing audit row, every time.
 *
 * The corollary is that this data is best-effort. It is a support aid, not a ledger, and it must
 * not be used for anything where a missing row would matter — billing, fraud decisions, or
 * reconciliation against MSG91's invoice.
 */

import { getBakerNetworkDbPool } from "../baker-network/db"

/**
 * How long an attempt row is kept.
 *
 * 90 days: long enough that "this happened a couple of months ago" is answerable, short enough that
 * we are not indefinitely holding mobile numbers belonging to people who never became customers and
 * never consented to anything beyond one sign-in attempt. See the migration for the reasoning.
 */
const RETENTION_DAYS = 90

/** Never let a logging failure surface to the caller. */
async function safely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.error(`[otp-log] ${label} failed (ignored)`, error)
  }
}

export interface RecordSendParams {
  mobile: string
  flowKey: string
  ok: boolean
  senderHeader?: string
  providerTemplateId?: string
  providerRequestId?: string | null
  providerError?: string | null
}

/**
 * One row per send, not per person.
 *
 * Resends therefore appear as separate rows, which is deliberate: "they pressed resend four times"
 * is exactly the signal that tells support this number is having trouble, and collapsing it into a
 * single row with a counter would hide the thing worth seeing.
 */
export async function recordSend(params: RecordSendParams): Promise<void> {
  await safely("recordSend", async () => {
    const pool = getBakerNetworkDbPool()
    await pool.query(
      `INSERT INTO crossfriend.otp_attempts
         (mobile, flow_key, status, provider_error, provider_request_id,
          sender_header, provider_template_id, sent_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9 || ' days')::interval)`,
      [
        params.mobile,
        params.flowKey,
        params.ok ? "sent" : "send_failed",
        // The provider's own words, kept because they are what makes a failure diagnosable. The
        // customer-facing message is deliberately generic and tells support nothing.
        params.ok ? null : (params.providerError ?? "").slice(0, 1000) || null,
        params.providerRequestId ?? null,
        params.senderHeader ?? null,
        params.providerTemplateId ?? null,
        params.ok ? new Date() : null,
        String(RETENTION_DAYS),
      ]
    )
  })
}

export interface RecordVerifyParams {
  mobile: string
  flowKey: string
  ok: boolean
  failureKind?: string | null
}

/**
 * Attaches the outcome to the most recent unverified send for this number.
 *
 * Matching on the latest row rather than carrying an id through the storefront: the public verify
 * contract takes only a mobile and a code, and threading an attempt id through it would mean the
 * browser holding a database key and being trusted to send it back honestly. The latest-row
 * heuristic is occasionally imprecise — two sends inside a second would attach to the newer — and
 * that is an acceptable trade for a support view that no decision depends on.
 */
export async function recordVerify(params: RecordVerifyParams): Promise<void> {
  await safely("recordVerify", async () => {
    const pool = getBakerNetworkDbPool()
    await pool.query(
      `UPDATE crossfriend.otp_attempts
          SET status            = CASE WHEN $3 THEN 'verified' ELSE 'verify_failed' END,
              verified_at       = CASE WHEN $3 THEN NOW() ELSE verified_at END,
              verify_attempts   = verify_attempts + 1,
              last_failure_kind = CASE WHEN $3 THEN NULL ELSE $4 END,
              updated_at        = NOW()
        WHERE id = (
          SELECT id FROM crossfriend.otp_attempts
           WHERE mobile = $1
             AND flow_key = $2
             AND status <> 'verified'
           ORDER BY requested_at DESC
           LIMIT 1
        )`,
      [params.mobile, params.flowKey, params.ok, params.failureKind ?? null]
    )
  })
}

/**
 * Deletes rows past their retention date.
 *
 * Called opportunistically from the send path rather than from a scheduler, because this project
 * has no job runner and adding one for a single daily DELETE would be more moving parts than the
 * problem deserves. The caller throttles it to roughly once a day; a purge that is occasionally
 * late is fine, a retention policy that exists only in a comment is not.
 */
export async function purgeExpiredAttempts(): Promise<void> {
  await safely("purgeExpiredAttempts", async () => {
    const pool = getBakerNetworkDbPool()
    const result = await pool.query(
      `DELETE FROM crossfriend.otp_attempts WHERE expires_at < NOW()`
    )
    if (result.rowCount) {
      console.log(`[otp-log] purged ${result.rowCount} expired attempt rows`)
    }
  })
}
