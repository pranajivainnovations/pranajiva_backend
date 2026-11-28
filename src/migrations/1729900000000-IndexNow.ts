import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * IndexNow (services/seo/indexnow.ts), inside the existing `seo` schema:
 *
 *   indexnow_urls         one row per page per site — the sitemap snapshot (in_sitemap, lastmod) and
 *                         the queue (state, reason, not_before, attempts) together, which is what
 *                         makes dedup free: a page is queued once however often it changes
 *   indexnow_submissions  one row per request to api.indexnow.org: pages, answer, timing (90 days)
 *   indexnow_state        per site, when the sitemap was last compared and what it found
 *
 * Gives PranaJiva its key (served by the storefront at /de44557d87b04a56923e84538b92c252.txt), only
 * where none is set. Additive.
 */
export const INDEXNOW_SQL = `
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
`

export class IndexNow1729900000000 implements MigrationInterface {
  name = "IndexNow1729900000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(INDEXNOW_SQL)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS seo.indexnow_state;
      DROP TABLE IF EXISTS seo.indexnow_submissions;
      DROP TABLE IF EXISTS seo.indexnow_urls;
      UPDATE seo.sites SET settings = settings - 'indexnowKey' WHERE slug = 'pranajiva';
    `)
  }
}
