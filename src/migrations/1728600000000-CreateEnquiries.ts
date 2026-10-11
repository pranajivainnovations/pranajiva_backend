import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Where a contact-form enquiry goes.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────────
 * It did not go anywhere. The Pranajiva contact form carried the comment `// Simulate API call`,
 * waited 1500 ms, showed "thank you, we'll be in touch", cleared the fields and discarded every
 * word. Anyone who used it was told their message had been received when nothing had been sent,
 * stored or seen. However long that has been live, those enquiries are gone.
 *
 * ── Why a table and not an email ───────────────────────────────────────────────────────────────
 * Because there is no mail service anywhere in this stack. There is no SMTP credential, no
 * transactional email provider and no sending domain; the only outbound channel that exists is
 * MSG91 SMS, and that is DLT-template-gated and currently dormant. This is also why corporate
 * gifting enquiries are wa.me links rather than a form — a form that cannot deliver either drops
 * the message or lies about it, and the existing one chose to lie.
 *
 * A row in a table cannot silently fail. It is written inside the request, the customer is told
 * only after it commits, and it stays until somebody acts on it. Email can be added later as a
 * notification *about* these rows without changing where the enquiry actually lives.
 *
 * ── Why brand is a column rather than a schema per brand ───────────────────────────────────────
 * The same form, with the same five fields, is wanted on both storefronts, and both already share
 * one customer table and one wallet. `support` is deliberately brand-neutral: Pranajiva is the
 * first user, CrossFriend is the obvious second, and neither needs a migration to join.
 *
 * ── On the shape ───────────────────────────────────────────────────────────────────────────────
 * `subject` and `status` are free text, checked only in the application, for the same reason
 * pranajiva.decisions keeps its vocabulary out of the database: adding "escalated" should be a
 * one-line change in OPS, not a migration. The application writes only values it knows.
 *
 * `customer_id` is nullable and unconstrained by design — most enquiries arrive from people who
 * are not signed in, and a signed-in sender's id is a convenience for OPS, not an integrity rule.
 * It deliberately has no foreign key to `customer`, so deleting a customer under GDPR-style
 * erasure does not cascade away the support history that may be the subject of the complaint.
 *
 * `source_ip_hash` is a hash, never an address: enough to rate-limit and to spot a flood, not
 * enough to be a personal-data liability in a table support staff read all day.
 *
 * Additive only — one new schema, one new table, nothing existing touched.
 */
export class CreateEnquiries1728600000000 implements MigrationInterface {
  name = "CreateEnquiries1728600000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS support`)

    await queryRunner.query(`
      CREATE TABLE support.enquiries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        email VARCHAR(320),
        phone VARCHAR(32),
        subject VARCHAR(64) NOT NULL DEFAULT 'other',
        message TEXT NOT NULL,
        customer_id VARCHAR(64),
        source_ip_hash VARCHAR(64),
        status VARCHAR(32) NOT NULL DEFAULT 'new',
        handled_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        handled_at TIMESTAMPTZ,
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT enquiries_brand_ck
          CHECK (brand IN ('crossfriend', 'pranajiva')),
        /* A message with neither an email nor a phone cannot be answered, so it is not an
           enquiry — it is a note to nobody. Enforced here because the storefront is not the only
           possible caller. */
        CONSTRAINT enquiries_reachable_ck
          CHECK (email IS NOT NULL OR phone IS NOT NULL),
        CONSTRAINT enquiries_message_ck
          CHECK (length(btrim(message)) >= 10),
        /* handled_at and handled_by travel together: a row claiming it was dealt with but not by
           whom, or by whom but not when, is worse than an untouched one. */
        CONSTRAINT enquiries_handled_ck
          CHECK ((handled_by IS NULL) = (handled_at IS NULL))
      )
    `)

    /* The queue OPS opens: everything unanswered, oldest first. Partial, because the answered
       rows are the ones that grow without bound and nobody opens the screen to see them. */
    await queryRunner.query(`
      CREATE INDEX idx_enquiries_open
        ON support.enquiries (brand, created_at)
        WHERE status = 'new'
    `)

    await queryRunner.query(`
      CREATE INDEX idx_enquiries_recent
        ON support.enquiries (brand, created_at DESC)
    `)

    /* Rate limiting reads this: how many from this sender in the last hour. */
    await queryRunner.query(`
      CREATE INDEX idx_enquiries_flood
        ON support.enquiries (source_ip_hash, created_at DESC)
        WHERE source_ip_hash IS NOT NULL
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS support.enquiries`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS support`)
  }
}
