-- Manual equivalent of 1729700000000-SeoMonitor.ts
--
-- SEO Health Monitor: a new `seo` schema (sites, runs, findings, mutes, pages), seeded with PranaJiva
-- and CrossFriend. The final INSERT registers it in TypeORM's ledger so `medusa migrations run` skips it.
--
-- To undo:
--   DROP SCHEMA IF EXISTS seo CASCADE;
--   DELETE FROM migrations WHERE timestamp = 1729700000000;

BEGIN;
CREATE SCHEMA IF NOT EXISTS seo;

CREATE TABLE IF NOT EXISTS seo.sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(48) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  base_url TEXT NOT NULL,
  sitemap_url TEXT NOT NULL,
  feed_url TEXT,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seo.runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES seo.sites(id) ON DELETE CASCADE,
  status VARCHAR(12) NOT NULL DEFAULT 'running',
  trigger VARCHAR(12) NOT NULL DEFAULT 'schedule',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  pages_checked INTEGER NOT NULL DEFAULT 0,
  score INTEGER,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_by VARCHAR(64),
  CONSTRAINT seo_runs_status_ck CHECK (status IN ('running', 'done', 'failed')),
  CONSTRAINT seo_runs_trigger_ck CHECK (trigger IN ('schedule', 'manual'))
);
CREATE INDEX IF NOT EXISTS idx_seo_runs_site ON seo.runs (site_id, started_at DESC);

CREATE TABLE IF NOT EXISTS seo.findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES seo.runs(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES seo.sites(id) ON DELETE CASCADE,
  check_id VARCHAR(48) NOT NULL,
  category VARCHAR(24) NOT NULL,
  severity VARCHAR(8) NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  fix TEXT,
  urls TEXT[] NOT NULL DEFAULT '{}',
  evidence JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seo_findings_severity_ck CHECK (severity IN ('error', 'warning', 'info'))
);
CREATE INDEX IF NOT EXISTS idx_seo_findings_run ON seo.findings (run_id, severity);
CREATE INDEX IF NOT EXISTS idx_seo_findings_fp ON seo.findings (site_id, fingerprint);

CREATE TABLE IF NOT EXISTS seo.mutes (
  site_id UUID NOT NULL REFERENCES seo.sites(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  note TEXT,
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS seo.pages (
  site_id UUID NOT NULL REFERENCES seo.sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status INTEGER,
  in_sitemap BOOLEAN NOT NULL DEFAULT FALSE,
  title TEXT,
  description TEXT,
  canonical TEXT,
  robots TEXT,
  h1_count INTEGER,
  words INTEGER,
  schema_types TEXT[] NOT NULL DEFAULT '{}',
  inlinks INTEGER NOT NULL DEFAULT 0,
  load_ms INTEGER,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, url)
);

INSERT INTO seo.sites (slug, name, base_url, sitemap_url, feed_url, settings)
VALUES
  ('pranajiva', 'PranaJiva', 'https://pranajiva.in', 'https://pranajiva.in/sitemap.xml',
   'https://pranajiva.in/feeds/google-shopping.xml',
   '{"productPath": "^/shop/[^/]+$", "claimCheck": true, "maxPages": 400, "thinWords": 250,
     "privatePaths": ["/tracker/", "!/tracker/guide", "/account", "/cart", "/checkout"], "ignorePaths": ["/api/", "/_next/", "/feeds/", "/feed.xml", "/og/", "/brand/", "/downloads/"]}'::jsonb),
  ('crossfriend', 'CrossFriend', 'https://crossfriend.in', 'https://crossfriend.in/sitemap.xml',
   NULL,
   '{"productPath": "", "claimCheck": false, "maxPages": 400, "thinWords": 250,
     "privatePaths": ["/account", "/cart", "/checkout", "/order/"], "ignorePaths": ["/api/", "/_next/", "/search"]}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO migrations ("timestamp", name) VALUES (1729700000000, 'SeoMonitor1729700000000');

COMMIT;
