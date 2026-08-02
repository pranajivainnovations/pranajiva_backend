import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Raw staging for Google Places API discovery sweeps — same two-table
 * pattern as pincode_directory/pincode_service_status, applied to bakers:
 * this table is disposable/re-fetchable, `bakers` is the authoritative
 * table the storefront actually reads.
 *
 * raw_response captures the complete parsed API response for whatever
 * fields were requested — guarantees nothing we asked Google for is ever
 * lost, even fields we didn't think to promote to their own column.
 *
 * place_id is globally unique (not scoped per search) — the same real
 * business found via two different pincode sweeps is one row, not two.
 * Re-sweeping only refreshes rows still at 'pending'/'on_hold' (enforced
 * at the DB level via the conditional ON CONFLICT the import/discovery
 * script uses) — an already-onboarded or dismissed candidate is frozen,
 * never silently touched by a later sweep.
 */
export class CreateBakerDiscoveries1722600000000 implements MigrationInterface {
  name = "CreateBakerDiscoveries1722600000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_discoveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        place_id TEXT NOT NULL UNIQUE,

        -- Provenance: which sweep first surfaced this candidate
        search_pincode VARCHAR(6),
        search_query TEXT,

        -- Promoted fields (extracted from the response for search/display/sort)
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

        -- Complete raw API response for whatever fields were requested — nothing is ever lost
        raw_response JSONB NOT NULL,

        -- Ops triage outcome
        review_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        -- 'pending' | 'onboarded' | 'on_hold' | 'dismissed'
        promoted_baker_id UUID REFERENCES baker_network.bakers(id) ON DELETE SET NULL,

        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(
      `CREATE INDEX idx_baker_discoveries_search_pincode ON baker_network.baker_discoveries(search_pincode);`
    )
    await queryRunner.query(
      `CREATE INDEX idx_baker_discoveries_review_status ON baker_network.baker_discoveries(review_status);`
    )

    // Google's own website field — bakers didn't have a home for this yet.
    await queryRunner.query(`ALTER TABLE baker_network.bakers ADD COLUMN website_url TEXT;`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE baker_network.bakers DROP COLUMN IF EXISTS website_url;`)
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_discoveries;`)
  }
}
