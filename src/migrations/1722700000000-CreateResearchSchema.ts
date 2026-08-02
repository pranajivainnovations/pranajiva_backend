import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Standalone R&D schema for exploring future categories (toys, bouquets, gifts, etc.) via Google
 * Places — completely separate from baker_network, on purpose. This is exploratory market research
 * ("is there real vendor presence for X in pincode Y?"), not production data, and must never leak into
 * or complicate what customers actually see. If a category later gets built out for real, it gets its
 * own dedicated schema/table the same way baker_network did for bakers — this data doesn't migrate
 * into that, it's just informs the decision to build it.
 */
export class CreateResearchSchema1722700000000 implements MigrationInterface {
  name = "CreateResearchSchema1722700000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS research;`)

    await queryRunner.query(`
      CREATE TABLE research.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(`
      CREATE TABLE research.search_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id UUID NOT NULL REFERENCES research.categories(id) ON DELETE CASCADE,
        place_id TEXT NOT NULL,

        search_pincode VARCHAR(6),
        search_query TEXT,

        display_name TEXT,
        formatted_address TEXT,
        district TEXT,
        state_name TEXT,
        postal_code VARCHAR(10),
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        rating NUMERIC(2, 1),
        user_rating_count INT,
        phone TEXT,
        website_url TEXT,
        business_status VARCHAR(30),
        primary_type TEXT,

        raw_response JSONB NOT NULL,

        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Same place can legitimately appear under more than one category (a shop might sell both
        -- toys and gifts) — uniqueness is per category, not global like baker_discoveries.
        UNIQUE (category_id, place_id)
      );
    `)
    await queryRunner.query(`CREATE INDEX idx_research_results_category ON research.search_results(category_id);`)
    await queryRunner.query(`CREATE INDEX idx_research_results_pincode ON research.search_results(search_pincode);`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS research.search_results;`)
    await queryRunner.query(`DROP TABLE IF EXISTS research.categories;`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS research;`)
  }
}
