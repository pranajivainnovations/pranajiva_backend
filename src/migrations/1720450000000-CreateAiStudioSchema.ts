import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Creates the ai_studio schema with two core tables:
 *
 * 1. ai_studio.generations — one row per generation request
 * 2. ai_studio.cake_designs — one row per generated image (searchable, reusable)
 *
 * This schema is completely independent of Medusa core tables.
 * Only foreign key dependency: customer_id references public.customer(id)
 */
export class CreateAiStudioSchema1720450000000 implements MigrationInterface {
  name = "CreateAiStudioSchema1720450000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Create schema ────────────────────────────────────────────────────────
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS ai_studio;`)

    // ── Generations table ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE ai_studio.generations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id VARCHAR(255) NOT NULL,

        -- Request details
        prompt TEXT NOT NULL,
        style VARCHAR(50) NOT NULL,
        occasion VARCHAR(50),
        flavor VARCHAR(50),
        zodiac_sign VARCHAR(20),
        zodiac_suggestion TEXT,

        -- Provider details
        provider VARCHAR(30) NOT NULL,
        provider_model VARCHAR(100) NOT NULL,

        -- Result
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        image_count INT DEFAULT 0,
        credit_cost INT DEFAULT 1,
        failed_reason TEXT,

        -- Timing
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        duration_ms INT
      );
    `)

    await queryRunner.query(`
      CREATE INDEX idx_gen_customer ON ai_studio.generations(customer_id);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_gen_status ON ai_studio.generations(status);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_gen_created ON ai_studio.generations(created_at DESC);
    `)

    // ── Cake Designs table ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE ai_studio.cake_designs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        generation_id UUID NOT NULL REFERENCES ai_studio.generations(id) ON DELETE CASCADE,
        customer_id VARCHAR(255) NOT NULL,

        -- Image
        image_url TEXT NOT NULL,
        s3_key TEXT NOT NULL DEFAULT '',
        image_index SMALLINT NOT NULL DEFAULT 0,

        -- Cake Attributes
        prompt TEXT NOT NULL,
        style VARCHAR(50) NOT NULL,
        occasion VARCHAR(50),
        flavor VARCHAR(50),
        zodiac_sign VARCHAR(20),

        -- AI Metadata
        provider VARCHAR(30) NOT NULL,
        provider_model VARCHAR(100) NOT NULL,

        -- Searchability & Recommendations
        tags TEXT[] DEFAULT '{}',

        -- Usage & Engagement
        view_count INT DEFAULT 0,
        save_count INT DEFAULT 0,
        order_count INT DEFAULT 0,
        is_public BOOLEAN DEFAULT true,
        is_featured BOOLEAN DEFAULT false,

        -- Status
        status VARCHAR(20) DEFAULT 'active',

        -- Timestamps
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(`
      CREATE INDEX idx_designs_generation ON ai_studio.cake_designs(generation_id);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_designs_customer ON ai_studio.cake_designs(customer_id);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_designs_style ON ai_studio.cake_designs(style);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_designs_occasion ON ai_studio.cake_designs(occasion);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_designs_flavor ON ai_studio.cake_designs(flavor);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_designs_tags ON ai_studio.cake_designs USING GIN(tags);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_designs_public_featured ON ai_studio.cake_designs(is_public, is_featured)
      WHERE status = 'active';
    `)
    await queryRunner.query(`
      CREATE INDEX idx_designs_created ON ai_studio.cake_designs(created_at DESC);
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.cake_designs;`)
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.generations;`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS ai_studio;`)
  }
}
