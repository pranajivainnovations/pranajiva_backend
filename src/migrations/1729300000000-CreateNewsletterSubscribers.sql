-- Manual equivalent of 1729300000000-CreateNewsletterSubscribers.ts
--
-- Use this when you want to apply ONLY this migration, rather than letting
-- `medusa migrations run` apply every pending one at once. The final INSERT
-- registers it in TypeORM's ledger so the runner will not try to apply it again.
--
-- Additive only: it adds one table to the existing `support` schema and touches
-- nothing that already exists. The undo at the bottom does NOT drop the schema,
-- because support.enquiries and support.sample_requests live in it.
--
-- Nothing works until this is applied: POST /store/newsletter answers 503 and
-- the footer tells the visitor their email could not be saved. That is
-- deliberate — the box must never claim to have stored an address it did not.
--
-- This table sends nothing. There is no mail service in this stack; a row here
-- is an address to write to by hand, or to export, when there is news.

BEGIN;

CREATE SCHEMA IF NOT EXISTS support;

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
  CONSTRAINT newsletter_subscribers_email_ck
    CHECK (email = lower(email) AND email LIKE '%_@_%')
);

-- One row per address per brand. Signing up twice must never become two rows,
-- or the same person is written to twice.
CREATE UNIQUE INDEX uq_newsletter_subscribers_email
  ON support.newsletter_subscribers (brand, email);

CREATE INDEX idx_newsletter_subscribers_flood
  ON support.newsletter_subscribers (source_ip_hash, created_at DESC)
  WHERE source_ip_hash IS NOT NULL;

-- Tell TypeORM this migration is already applied, so `medusa migrations run`
-- skips it instead of failing on "relation already exists".
INSERT INTO migrations (timestamp, name)
VALUES (1729300000000, 'CreateNewsletterSubscribers1729300000000')
ON CONFLICT DO NOTHING;

COMMIT;

-- To undo (leaves the support schema and its other tables alone):
--   DROP TABLE IF EXISTS support.newsletter_subscribers;
--   DELETE FROM migrations WHERE timestamp = 1729300000000;
