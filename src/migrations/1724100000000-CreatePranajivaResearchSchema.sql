-- Manual equivalent of 1724100000000-CreatePranajivaResearchSchema.ts
--
-- Use this when you want to apply ONLY this migration, rather than letting
-- `medusa migrations run` apply every pending one at once. The final INSERT
-- registers it in TypeORM's ledger so the runner will not try to apply it again.
--
-- Additive only: it creates a new schema and one table, and touches nothing that
-- already exists. Reversible with the DROP statements at the bottom.

BEGIN;

CREATE SCHEMA IF NOT EXISTS pranajiva;

CREATE TABLE pranajiva.decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind VARCHAR(32) NOT NULL,
  subject_key VARCHAR(200) NOT NULL,
  status VARCHAR(32),
  note TEXT NOT NULL DEFAULT '',
  decided_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subject_kind, subject_key)
);

CREATE INDEX idx_pranajiva_decisions_kind_status
  ON pranajiva.decisions (subject_kind, status);

-- Tell TypeORM this migration is already applied, so `medusa migrations run`
-- skips it instead of failing on "schema already exists".
INSERT INTO migrations (timestamp, name)
VALUES (1724100000000, 'CreatePranajivaResearchSchema1724100000000')
ON CONFLICT DO NOTHING;

COMMIT;

-- To undo:
--   DROP TABLE IF EXISTS pranajiva.decisions;
--   DROP SCHEMA IF EXISTS pranajiva;
--   DELETE FROM migrations WHERE timestamp = 1724100000000;
