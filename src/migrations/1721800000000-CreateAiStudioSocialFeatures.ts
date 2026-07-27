import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Adds Like / Comment / Report to the ai_studio schema.
 *
 * - design_likes: one row per (design, customer) like. `cake_designs.save_count`
 *   remains the denormalized counter this table backs — no new counter column
 *   for likes, since the storefront already displays save_count as "likeCount".
 * - design_comments: one row per comment. `cake_designs.comment_count` is the
 *   new denormalized counter for these.
 * - reports: flags either a design or a comment (never both) for moderation.
 *   One report per (reporter, target) — repeat reports from the same user
 *   don't inflate the count used for auto-hide thresholds.
 */
export class CreateAiStudioSocialFeatures1721800000000 implements MigrationInterface {
  name = "CreateAiStudioSocialFeatures1721800000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Likes ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE ai_studio.design_likes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        design_id UUID NOT NULL REFERENCES ai_studio.cake_designs(id) ON DELETE CASCADE,
        customer_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(design_id, customer_id)
      );
    `)
    await queryRunner.query(`
      CREATE INDEX idx_likes_design ON ai_studio.design_likes(design_id);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_likes_customer ON ai_studio.design_likes(customer_id);
    `)

    // ── Comments ─────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE ai_studio.design_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        design_id UUID NOT NULL REFERENCES ai_studio.cake_designs(id) ON DELETE CASCADE,
        customer_id VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await queryRunner.query(`
      CREATE INDEX idx_comments_design ON ai_studio.design_comments(design_id);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_comments_customer ON ai_studio.design_comments(customer_id);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_comments_created ON ai_studio.design_comments(created_at DESC);
    `)

    // ── Reports (designs or comments) ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE ai_studio.reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        design_id UUID REFERENCES ai_studio.cake_designs(id) ON DELETE CASCADE,
        comment_id UUID REFERENCES ai_studio.design_comments(id) ON DELETE CASCADE,
        reporter_customer_id VARCHAR(255) NOT NULL,
        reason VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_report_target CHECK (
          (design_id IS NOT NULL AND comment_id IS NULL) OR
          (design_id IS NULL AND comment_id IS NOT NULL)
        )
      );
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_reports_design_reporter
        ON ai_studio.reports(design_id, reporter_customer_id)
        WHERE design_id IS NOT NULL;
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_reports_comment_reporter
        ON ai_studio.reports(comment_id, reporter_customer_id)
        WHERE comment_id IS NOT NULL;
    `)

    // ── New counter on cake_designs (likes reuse the existing save_count) ───
    await queryRunner.query(`
      ALTER TABLE ai_studio.cake_designs ADD COLUMN comment_count INT DEFAULT 0;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ai_studio.cake_designs DROP COLUMN IF EXISTS comment_count;`)
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.reports;`)
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.design_comments;`)
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.design_likes;`)
  }
}
