-- Manual equivalent of 1729200000000-CreateSampleRequests.ts
--
-- Use this when you want to apply ONLY this migration, rather than letting
-- `medusa migrations run` apply every pending one at once. The final INSERT
-- registers it in TypeORM's ledger so the runner will not try to apply it again.
--
-- Additive only: it adds one table to the existing `support` schema and touches
-- nothing that already exists. The undo at the bottom does NOT drop the schema,
-- because support.enquiries lives in it.
--
-- Nothing works until this is applied: POST /store/sample-request answers 503
-- and the sample page tells the visitor to WhatsApp or call instead. That is
-- deliberate — the form must never claim to have filed something it did not.

BEGIN;

CREATE SCHEMA IF NOT EXISTS support;

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
  CONSTRAINT sample_requests_phone_ck
    CHECK (phone ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT sample_requests_pincode_ck
    CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT sample_requests_handled_ck
    CHECK ((handled_by IS NULL) = (handled_at IS NULL))
);

-- One sample per phone number per brand, for good. This is the abuse control,
-- and it is a database constraint because a check-then-insert in application
-- code cannot survive two concurrent submissions.
CREATE UNIQUE INDEX uq_sample_requests_phone
  ON support.sample_requests (brand, phone);

CREATE INDEX idx_sample_requests_open
  ON support.sample_requests (brand, created_at)
  WHERE status = 'new';

CREATE INDEX idx_sample_requests_recent
  ON support.sample_requests (brand, created_at DESC);

CREATE INDEX idx_sample_requests_flood
  ON support.sample_requests (source_ip_hash, created_at DESC)
  WHERE source_ip_hash IS NOT NULL;

-- Tell TypeORM this migration is already applied, so `medusa migrations run`
-- skips it instead of failing on "relation already exists".
INSERT INTO migrations (timestamp, name)
VALUES (1729200000000, 'CreateSampleRequests1729200000000')
ON CONFLICT DO NOTHING;

COMMIT;

-- To undo (leaves the support schema and support.enquiries alone):
--   DROP TABLE IF EXISTS support.sample_requests;
--   DELETE FROM migrations WHERE timestamp = 1729200000000;
