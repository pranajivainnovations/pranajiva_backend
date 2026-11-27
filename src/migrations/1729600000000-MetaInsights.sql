-- Manual equivalent of 1729600000000-MetaInsights.ts
--
-- Instagram analytics, content ideas and the competitor watchlist: five new tables in the meta schema.
-- The final INSERT registers it in TypeORM's ledger so `medusa migrations run` skips it.
--
-- To undo:
--   DROP TABLE IF EXISTS meta.competitor_media, meta.competitors, meta.insight_reports, meta.account_insights, meta.media_insights;
--   DELETE FROM migrations WHERE timestamp = 1729600000000;

BEGIN;

CREATE TABLE IF NOT EXISTS meta.media_insights (
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  media_id VARCHAR(64) NOT NULL,
  like_count INTEGER,
  comments_count INTEGER,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, media_id)
);

CREATE TABLE IF NOT EXISTS meta.account_insights (
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS meta.insight_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  kind VARCHAR(24) NOT NULL,
  body JSONB NOT NULL,
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_insight_reports_kind_ck CHECK (kind IN ('access_check', 'account_totals', 'audience', 'content_ideas'))
);
CREATE INDEX IF NOT EXISTS idx_meta_insight_reports ON meta.insight_reports (account_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS meta.competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  username VARCHAR(64) NOT NULL,
  note TEXT,
  profile JSONB,
  last_fetched_at TIMESTAMPTZ,
  last_error TEXT,
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_competitors ON meta.competitors (account_id, LOWER(username));

CREATE TABLE IF NOT EXISTS meta.competitor_media (
  competitor_id UUID NOT NULL REFERENCES meta.competitors(id) ON DELETE CASCADE,
  media_id VARCHAR(64) NOT NULL,
  caption TEXT,
  media_type VARCHAR(32),
  product_type VARCHAR(32),
  permalink TEXT,
  posted_at TIMESTAMPTZ,
  like_count INTEGER,
  comments_count INTEGER,
  view_count INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (competitor_id, media_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_competitor_media_posted ON meta.competitor_media (competitor_id, posted_at DESC);

INSERT INTO migrations (timestamp, name) VALUES (1729600000000, 'MetaInsights1729600000000');

COMMIT;
