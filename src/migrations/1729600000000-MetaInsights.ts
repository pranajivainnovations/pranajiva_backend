import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Instagram analytics, content ideas and the competitor watchlist (services/meta/insights.ts).
 *
 *   media_insights     latest numbers per post/reel: views, reach, saves, shares, watch time…
 *   account_insights   one row per account and day: reach, follower count
 *   insight_reports    the latest access check, 30-day totals, audience, AI content ideas — JSON
 *   competitors        public business/creator accounts we watch through Business Discovery
 *   competitor_media   their recent posts with likes, comments (and views where Meta gives them)
 *
 * Additive: new tables in the `meta` schema only.
 */
export const META_INSIGHTS_SQL = `
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
`

export class MetaInsights1729600000000 implements MigrationInterface {
  name = "MetaInsights1729600000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(META_INSIGHTS_SQL)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS meta.competitor_media;
      DROP TABLE IF EXISTS meta.competitors;
      DROP TABLE IF EXISTS meta.insight_reports;
      DROP TABLE IF EXISTS meta.account_insights;
      DROP TABLE IF EXISTS meta.media_insights;
    `)
  }
}
