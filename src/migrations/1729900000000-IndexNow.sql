-- Manual equivalent of 1729900000000-IndexNow.ts
--
-- IndexNow queue, snapshot and submission log in the seo schema, plus PranaJiva's key. The final
-- INSERT registers it in TypeORM's ledger so `medusa migrations run` skips it.
--
-- To undo:
--   DROP TABLE IF EXISTS seo.indexnow_state, seo.indexnow_submissions, seo.indexnow_urls;
--   UPDATE seo.sites SET settings = settings - 'indexnowKey' WHERE slug = 'pranajiva';
--   DELETE FROM migrations WHERE timestamp = 1729900000000;

BEGIN;
CREATE TABLE IF NOT EXISTS seo.indexnow_urls (
  site_id UUID NOT NULL REFERENCES seo.sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  in_sitemap BOOLEAN NOT NULL DEFAULT FALSE,
  lastmod TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state VARCHAR(10) NOT NULL DEFAULT 'idle',
  reason VARCHAR(10),
  source VARCHAR(40),
  queued_at TIMESTAMPTZ,
  not_before TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_tried_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  PRIMARY KEY (site_id, url),
  CONSTRAINT seo_indexnow_urls_state_ck CHECK (state IN ('idle', 'queued', 'failed', 'skipped'))
);
CREATE INDEX IF NOT EXISTS seo_indexnow_urls_due_idx ON seo.indexnow_urls (site_id, not_before) WHERE state = 'queued';

CREATE TABLE IF NOT EXISTS seo.indexnow_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES seo.sites(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger VARCHAR(10) NOT NULL DEFAULT 'auto',
  urls TEXT[] NOT NULL,
  url_count INTEGER NOT NULL,
  status INTEGER,
  ok BOOLEAN NOT NULL,
  error TEXT,
  response TEXT,
  ms INTEGER,
  created_by VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS seo_indexnow_submissions_site_idx ON seo.indexnow_submissions (site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seo.indexnow_state (
  site_id UUID PRIMARY KEY REFERENCES seo.sites(id) ON DELETE CASCADE,
  last_scan_at TIMESTAMPTZ,
  last_try_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scan JSONB NOT NULL DEFAULT '{}'::jsonb
);

UPDATE seo.sites
   SET settings = settings || '{"indexnowKey": "de44557d87b04a56923e84538b92c252"}'::jsonb,
       updated_at = NOW()
 WHERE slug = 'pranajiva' AND NOT (settings ? 'indexnowKey');

INSERT INTO migrations ("timestamp", name) VALUES (1729900000000, 'IndexNow1729900000000');

COMMIT;
