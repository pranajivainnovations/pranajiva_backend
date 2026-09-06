import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * DLT sender headers, SMS templates, and which template each product flow sends through.
 *
 * ── Why this is not in crossfriend.site_settings ───────────────────────────────────────────────
 * That table is served by an unauthenticated route and its own migration says nothing private may
 * go in it. A DLT template ID is not a catastrophic leak, but it is an operational identifier that
 * belongs to our TRAI registration, and the row here also carries the header a scraper would need
 * to impersonate our SMS convincingly. So it gets its own tables, read only over server-side paths.
 *
 * The MSG91 auth key is deliberately absent. It can send SMS and spend money, which makes it a
 * credential rather than a setting, and it stays in the backend environment with DATABASE_URL and
 * the AI provider keys. Nothing in OPS should be able to read it back out.
 *
 * ── Why two tables rather than a header column on the flow ─────────────────────────────────────
 * On DLT a template is registered *underneath* a header — the pairing is fixed by TRAI, not by us.
 * Modelling templates as rows that each carry their own header, and pointing a flow at a template,
 * therefore matches the upstream reality: "change the header for AI cake login" is expressed as
 * "point that flow at a template registered under the other header", which is the only change that
 * is actually legal. A free-text header column on the flow would let OPS compose a header/template
 * pair that DLT will reject at send time, and the failure would surface as customers not receiving
 * their OTP rather than as a validation error in the tool.
 *
 * ── Why the OTP parameters live on the flow ────────────────────────────────────────────────────
 * Length, TTL, attempt caps and cooldown are per-flow policy, not per-template. A login OTP and a
 * future order-confirmation OTP want different numbers, and tying them to the template would mean
 * re-registering with DLT to change a timeout.
 */
export class CreateMessagingConfig1724200000000 implements MigrationInterface {
  name = "CreateMessagingConfig1724200000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.sms_templates (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label             VARCHAR(120) NOT NULL,
        sender_header     VARCHAR(16)  NOT NULL,
        dlt_template_id   VARCHAR(64)  NOT NULL,
        provider_template_id VARCHAR(64) NOT NULL DEFAULT '',
        body_preview      TEXT NOT NULL DEFAULT '',
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by        UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    // A DLT template ID is unique per registration. Enforcing it here means a copy-paste of the
    // wrong row in OPS fails loudly at save instead of silently creating two rows that claim to be
    // the same registered template, only one of which anyone remembers to keep current.
    await queryRunner.query(`
      CREATE UNIQUE INDEX sms_templates_dlt_template_id_key
        ON crossfriend.sms_templates (dlt_template_id);
    `)

    await queryRunner.query(`
      CREATE TABLE crossfriend.message_flows (
        flow_key          VARCHAR(64) PRIMARY KEY,
        label             VARCHAR(120) NOT NULL,
        description       TEXT NOT NULL DEFAULT '',
        template_id       UUID REFERENCES crossfriend.sms_templates(id) ON DELETE RESTRICT,
        otp_length        SMALLINT NOT NULL DEFAULT 6,
        otp_ttl_seconds   INTEGER  NOT NULL DEFAULT 300,
        max_attempts      SMALLINT NOT NULL DEFAULT 5,
        resend_cooldown_seconds INTEGER NOT NULL DEFAULT 30,
        daily_send_limit  SMALLINT NOT NULL DEFAULT 10,
        is_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
        updated_by        UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    /**
     * ON DELETE RESTRICT above, not SET NULL: deleting a template that a live flow is sending
     * through would silently disable customer login. Making that deletion fail is the point — OPS
     * has to reassign the flow first, which is a deliberate act with a visible consequence.
     *
     * Bounds as CHECK constraints rather than validation in OPS alone. OPS is one writer; psql and
     * any future script are others, and an otp_ttl of 0 or an otp_length of 2 is a security defect,
     * not a preference. The upper bounds matter as much as the lower ones: a 30-minute OTP window
     * or 50 permitted attempts makes brute force practical against a 6-digit code.
     */
    await queryRunner.query(`
      ALTER TABLE crossfriend.message_flows
        ADD CONSTRAINT message_flows_otp_length_ck   CHECK (otp_length BETWEEN 4 AND 8),
        ADD CONSTRAINT message_flows_ttl_ck          CHECK (otp_ttl_seconds BETWEEN 60 AND 900),
        ADD CONSTRAINT message_flows_attempts_ck     CHECK (max_attempts BETWEEN 3 AND 10),
        ADD CONSTRAINT message_flows_cooldown_ck     CHECK (resend_cooldown_seconds BETWEEN 15 AND 300),
        ADD CONSTRAINT message_flows_daily_limit_ck  CHECK (daily_send_limit BETWEEN 1 AND 50);
    `)

    /**
     * The one flow that exists today: signing in to generate a cake in the AI Studio.
     *
     * Seeded with no template and is_enabled = FALSE, which is the honest starting state — the DLT
     * header registration is still in progress, so there is nothing real to point at yet. The send
     * path treats a disabled or unassigned flow as a hard failure rather than falling back to
     * anything, so this row cannot accidentally behave like the mock it replaces.
     */
    await queryRunner.query(`
      INSERT INTO crossfriend.message_flows (flow_key, label, description) VALUES
        (
          'ai_studio_login',
          'AI Cake Studio — sign in',
          'One-time password sent when a customer signs in with their mobile number to generate a cake design.'
        )
      ON CONFLICT (flow_key) DO NOTHING;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.message_flows;`)
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.sms_templates;`)
  }
}
