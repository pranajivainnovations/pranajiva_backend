import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Where a free-sample request goes.
 *
 * ── Why not a row in support.enquiries with subject 'sample-request' ──────────────────────────
 * Because a sample is posted, and an enquiry is answered. The enquiries table has `message` and no
 * address, so the only way to file a sample request there is to put a street address inside a block
 * of free text — and then nobody can print a label from it without reading and retyping it, nobody
 * can check a pincode against it, and nobody can ask how many sachets went to Maharashtra last
 * month. The fields below are the same fields a dispatch slip has, which is the actual job.
 *
 * It also has a different lifecycle. An enquiry is new or handled. A sample request is new,
 * approved, dispatched or rejected, and the dispatched ones carry a date and a courier reference
 * that an enquiry has no column for.
 *
 * ── Why one per phone number is a UNIQUE INDEX and not just an application check ───────────────
 * Because the application check loses a race. Two submissions from the same phone a few
 * milliseconds apart both run their SELECT, both find nothing, and both insert — which is exactly
 * the pattern anyone farming free samples will produce, deliberately or by double-clicking. The
 * service checks first so the visitor gets a sentence explaining the limit rather than a database
 * error, and the index is what makes the limit true.
 *
 * Scoped to (brand, phone) rather than phone alone: the two storefronts sell unrelated things, and
 * a CrossFriend customer should not be refused a PranaJiva sachet because of a cake.
 *
 * Deliberately NOT unique on email. One household shares an email address more often than it
 * shares a mobile number, and phone is already the identity this stack uses — OTP login treats one
 * mobile as one customer across both brands. Blocking on email would refuse a spouse.
 *
 * ── Why both phone and email are NOT NULL here when enquiries allows either ───────────────────
 * An enquiry needs one way to reply. A sample needs the phone, because that is what the courier
 * calls and what the one-per-person limit is keyed on, and the email was asked for explicitly so
 * there is somewhere to send the follow-up when a mail service eventually exists. There is no mail
 * service in this stack today, which is also why nothing in this feature promises a confirmation
 * email.
 *
 * ── Why the address is five columns and not one ────────────────────────────────────────────────
 * `city` and `state` are filled by /store/pincode/lookup from the pincode, so the visitor types
 * neither; storing them separately anyway means a label can be printed without a second lookup, and
 * a lookup that later disagrees with what was captured does not silently change where a sachet was
 * meant to go. `landmark` exists because Indian addresses genuinely need it and a courier will ring
 * about it.
 *
 * ── On status and the vocabulary ───────────────────────────────────────────────────────────────
 * Free text, checked in the application, for the same reason support.enquiries keeps its subjects
 * out of the database: adding "returned to sender" should be a line in OPS, not a migration. The
 * application writes only values it knows.
 *
 * `source_ip_hash` is a hash and never an address, matching enquiries — enough to spot a flood,
 * not a personal-data liability in a table staff read all day.
 *
 * Additive only. The `support` schema already exists for enquiries; this adds one table to it and
 * touches nothing else. The down migration deliberately does NOT drop the schema, because
 * enquiries lives there.
 */
export class CreateSampleRequests1729200000000 implements MigrationInterface {
  name = "CreateSampleRequests1729200000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* Already created by CreateEnquiries, but this keeps the migration standalone. */
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS support`)

    await queryRunner.query(`
      CREATE TABLE support.sample_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        phone VARCHAR(16) NOT NULL,
        email VARCHAR(320) NOT NULL,
        product_handle VARCHAR(160) NOT NULL,
        address_line1 VARCHAR(300) NOT NULL,
        address_line2 VARCHAR(300),
        landmark VARCHAR(200),
        city VARCHAR(120) NOT NULL,
        state VARCHAR(120) NOT NULL,
        pincode VARCHAR(6) NOT NULL,
        reason TEXT,
        marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        customer_id VARCHAR(64),
        source_ip_hash VARCHAR(64),
        status VARCHAR(32) NOT NULL DEFAULT 'new',
        handled_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        handled_at TIMESTAMPTZ,
        note TEXT NOT NULL DEFAULT '',
        dispatched_at TIMESTAMPTZ,
        courier_ref VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT sample_requests_brand_ck
          CHECK (brand IN ('crossfriend', 'pranajiva')),
        /* Stored normalised to ten digits by the service. Checked here because the storefront is
           not the only possible caller, and because the one-per-person index is keyed on this
           column — an unnormalised duplicate would defeat it. */
        CONSTRAINT sample_requests_phone_ck
          CHECK (phone ~ '^[6-9][0-9]{9}$'),
        CONSTRAINT sample_requests_pincode_ck
          CHECK (pincode ~ '^[1-9][0-9]{5}$'),
        /* handled_at and handled_by travel together: a row claiming it was dealt with but not by
           whom, or by whom but not when, is worse than an untouched one. */
        CONSTRAINT sample_requests_handled_ck
          CHECK ((handled_by IS NULL) = (handled_at IS NULL))
      )
    `)

    /**
     * One sample per phone number per brand, for good.
     *
     * This is the whole abuse control, and it is here rather than only in the service because a
     * check-then-insert in application code cannot survive two concurrent submissions.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_sample_requests_phone
        ON support.sample_requests (brand, phone)
    `)

    /* The queue OPS opens: everything not yet dealt with, oldest first. Partial, because the
       dispatched rows are the ones that grow without bound and nobody opens the screen for them. */
    await queryRunner.query(`
      CREATE INDEX idx_sample_requests_open
        ON support.sample_requests (brand, created_at)
        WHERE status = 'new'
    `)

    await queryRunner.query(`
      CREATE INDEX idx_sample_requests_recent
        ON support.sample_requests (brand, created_at DESC)
    `)

    /* Rate limiting reads this: how many from this sender in the last hour. */
    await queryRunner.query(`
      CREATE INDEX idx_sample_requests_flood
        ON support.sample_requests (source_ip_hash, created_at DESC)
        WHERE source_ip_hash IS NOT NULL
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* The schema is NOT dropped: support.enquiries lives in it. */
    await queryRunner.query(`DROP TABLE IF EXISTS support.sample_requests`)
  }
}
