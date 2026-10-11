-- Manual equivalent of 1728600000000-CreateEnquiries.ts
--
-- Use this when you want to apply ONLY this migration, rather than letting
-- `medusa migrations run` apply every pending one at once. The final INSERT
-- registers it in TypeORM's ledger so the runner will not try to apply it again.
--
-- Additive only: it creates a new schema and one table, and touches nothing that
-- already exists. Reversible with the DROP statements at the bottom.
--
-- Nothing works until this is applied: POST /store/contact answers 503 and the
-- contact form tells the visitor to call or email instead. That is deliberate —
-- the form must never again claim to have sent something it did not.

BEGIN;

CREATE SCHEMA IF NOT EXISTS support;

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
  CONSTRAINT enquiries_reachable_ck
    CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT enquiries_message_ck
    CHECK (length(btrim(message)) >= 10),
  CONSTRAINT enquiries_handled_ck
    CHECK ((handled_by IS NULL) = (handled_at IS NULL))
);

CREATE INDEX idx_enquiries_open
  ON support.enquiries (brand, created_at)
  WHERE status = 'new';

CREATE INDEX idx_enquiries_recent
  ON support.enquiries (brand, created_at DESC);

CREATE INDEX idx_enquiries_flood
  ON support.enquiries (source_ip_hash, created_at DESC)
  WHERE source_ip_hash IS NOT NULL;

-- Tell TypeORM this migration is already applied, so `medusa migrations run`
-- skips it instead of failing on "schema already exists".
INSERT INTO migrations (timestamp, name)
VALUES (1728600000000, 'CreateEnquiries1728600000000')
ON CONFLICT DO NOTHING;

COMMIT;

-- To undo:
--   DROP TABLE IF EXISTS support.enquiries;
--   DROP SCHEMA IF EXISTS support;
--   DELETE FROM migrations WHERE timestamp = 1728600000000;
