import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Email addresses left in a storefront's "tell me when something new is ready" box.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 * The PranaJiva footer had a sign-up box that wrote the address into the visitor's own browser and
 * then announced success. Nothing ever reached us, so everyone who signed up was told they had
 * joined a list that did not exist. This table is the list.
 *
 * ── What it deliberately is not ──────────────────────────────────────────────────────────────
 * It is not a mailing system. There is no mail service anywhere in this stack, so a row here sends
 * nothing to anybody; it is an address to write to by hand, or to export, when there is news.
 *
 * Additive only: one table in the existing `support` schema.
 */
export class CreateNewsletterSubscribers1729300000000 implements MigrationInterface {
  name = "CreateNewsletterSubscribers1729300000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* Already created by CreateEnquiries, but this keeps the migration standalone. */
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS support`)

    await queryRunner.query(`
      CREATE TABLE support.newsletter_subscribers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand VARCHAR(32) NOT NULL,
        email VARCHAR(320) NOT NULL,
        source VARCHAR(64) NOT NULL DEFAULT 'footer',
        customer_id VARCHAR(64),
        source_ip_hash VARCHAR(64),
        unsubscribed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT newsletter_subscribers_brand_ck
          CHECK (brand IN ('crossfriend', 'pranajiva')),
        /* Stored lower-cased by the service. Checked here because the one-row-per-address index is
           keyed on this column, and "A@x.in" beside "a@x.in" would defeat it. */
        CONSTRAINT newsletter_subscribers_email_ck
          CHECK (email = lower(email) AND email LIKE '%_@_%')
      )
    `)

    /* One row per address per brand. Signing up twice is not an error for the visitor — the
       service turns it into "you are on the list" — but it must never become two rows, or the
       same person is written to twice. */
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_newsletter_subscribers_email
        ON support.newsletter_subscribers (brand, email)
    `)

    /* The flood check: how many sign-ups came from this connection in the last hour. */
    await queryRunner.query(`
      CREATE INDEX idx_newsletter_subscribers_flood
        ON support.newsletter_subscribers (source_ip_hash, created_at DESC)
        WHERE source_ip_hash IS NOT NULL
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* The schema is NOT dropped: support.enquiries and support.sample_requests live in it. */
    await queryRunner.query(`DROP TABLE IF EXISTS support.newsletter_subscribers`)
  }
}
