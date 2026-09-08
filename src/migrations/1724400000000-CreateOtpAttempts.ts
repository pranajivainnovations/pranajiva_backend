import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Every OTP sign-in attempt, so support can see who tried and where it went wrong.
 *
 * Before this, a customer saying "I never got the code" could only be answered by reading container
 * logs on a production host — which meant in practice it was not answered. The people this table is
 * for are precisely the ones who are invisible everywhere else: they never became a customer, so
 * they appear in no order, no account, and no analytics funnel beyond a page view.
 *
 * ── The OTP itself is never stored ─────────────────────────────────────────────────────────────
 * Not the code, not a hash of it. MSG91 owns the code under SendOTP and we could not record it if
 * we wanted to, but the rule would hold anyway: a support screen that displays live OTPs turns
 * every OPS account into a way to take over any customer's sign-in. What is recorded is metadata —
 * that an attempt happened, what the provider said, and whether it ended in a verification.
 *
 * ── This is personal data about people who are not customers ───────────────────────────────────
 * A mobile number is personal data under the DPDP Act 2023, and the rows here are mostly people who
 * did NOT complete sign-in — so there is no account, no relationship, and no consent beyond having
 * typed the number into a form. Two consequences are built in rather than left to policy:
 *
 *   - `expires_at` is set on write and old rows are purged automatically. Diagnosing a failed
 *     sign-in is a short-lived need; keeping the numbers indefinitely is not that need, it is a
 *     different one nobody asked for.
 *   - No IP address and no user agent. They would help almost never and are a meaningful widening
 *     of what is held about someone who only failed to log in.
 *
 * Using these numbers for marketing is a separate decision with separate law attached (TRAI's
 * unsolicited-communication rules), and nothing here should be read as consent to be contacted.
 */
export class CreateOtpAttempts1724400000000 implements MigrationInterface {
  name = "CreateOtpAttempts1724400000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.otp_attempts (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile               VARCHAR(15) NOT NULL,
        flow_key             VARCHAR(64) NOT NULL,

        /**
         * requested → the row exists because someone pressed the button
         * sent          delivered to the provider successfully
         * send_failed   the provider refused; the customer got nothing
         * verified      they completed sign-in
         * verify_failed at least one wrong or late code, never completed
         */
        status               VARCHAR(24) NOT NULL DEFAULT 'requested',

        -- What the provider said, so support does not have to reproduce the failure to see it.
        provider_error       TEXT,
        provider_request_id  VARCHAR(120),
        sender_header        VARCHAR(16),
        provider_template_id VARCHAR(64),

        verify_attempts      SMALLINT NOT NULL DEFAULT 0,
        last_failure_kind    VARCHAR(32),

        requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at              TIMESTAMPTZ,
        verified_at          TIMESTAMPTZ,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Retention is a column, not a policy document, so the deletion actually happens.
        expires_at           TIMESTAMPTZ NOT NULL
      );
    `)

    // Support's most common question is "what happened for this number", and the answer is almost
    // always the most recent few rows — hence mobile plus a descending time, not mobile alone.
    await queryRunner.query(`
      CREATE INDEX otp_attempts_mobile_idx
        ON crossfriend.otp_attempts (mobile, requested_at DESC);
    `)

    // Drives the default OPS view (newest first) and the purge sweep.
    await queryRunner.query(`
      CREATE INDEX otp_attempts_requested_idx
        ON crossfriend.otp_attempts (requested_at DESC);
    `)
    await queryRunner.query(`
      CREATE INDEX otp_attempts_expires_idx
        ON crossfriend.otp_attempts (expires_at);
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.otp_attempts;`)
  }
}
