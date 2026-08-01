import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Baker Network — dedicated schema, same Postgres instance as Medusa (same
 * pattern as ai_studio). Lets the Medusa backend query baker eligibility
 * directly via SQL, no second database or network hop, while keeping this
 * data out of Medusa's own core tables. A separate internal ops tool
 * (own subdomain, password-protected) will read/write this schema later —
 * see AI-Context/PROJECT-TRACKER/STATUS.md and ROADMAP.md Phase 2.
 *
 * V1 scope deliberately kept flat (one table, no per-stage-transition audit
 * log, no separate service-pincode junction table) — those are easy,
 * additive changes once the ops tool actually needs them, not a redesign.
 */
export class CreateBakerNetworkSchema1722100000000 implements MigrationInterface {
  name = "CreateBakerNetworkSchema1722100000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS baker_network;`)

    await queryRunner.query(`
      CREATE TABLE baker_network.bakers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- Identity / contact
        name TEXT NOT NULL,
        contact_person TEXT,
        phone VARCHAR(20),
        whatsapp_number VARCHAR(20),
        email VARCHAR(255),

        -- Geography (built India-wide-ready from day one, even though V1 is NCR-only)
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        pincode VARCHAR(10),
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        service_radius_km NUMERIC(5, 2),
        -- Explicit override for bakers whose real delivery area doesn't match a clean radius circle.
        -- NULL/empty means "just use service_radius_km from lat/lng".
        serviceable_pincodes TEXT[],

        -- Onboarding / outreach CRM status
        status VARCHAR(20) NOT NULL DEFAULT 'prospect',
        -- 'prospect' | 'contacted' | 'negotiating' | 'agreed' | 'onboarded' | 'declined' | 'inactive'
        status_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source VARCHAR(100), -- e.g. 'NCR Maps sweep'
        assigned_to VARCHAR(255), -- ops person's name/email — free text until the ops tool has real user accounts
        notes TEXT,

        -- Fulfillment / commerce
        wholesale_pricing_notes TEXT,
        avg_turnaround_hours INT,
        specialty_tags TEXT[], -- e.g. 'eggless', 'fondant', '3d_sculpted', 'budget', 'premium'
        reliability_rating NUMERIC(2, 1), -- internal rating, distinct from google_rating below

        -- Public-directory-ready (cheap to add now, unused until Phase 3)
        slug VARCHAR(255) UNIQUE,
        is_public BOOLEAN NOT NULL DEFAULT false,
        featured_priority INT NOT NULL DEFAULT 0,
        bio TEXT,
        profile_photo_url TEXT,
        google_place_id VARCHAR(255) UNIQUE, -- dedupes repeat Places-API sweeps
        google_rating NUMERIC(2, 1),
        google_review_count INT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(`CREATE INDEX idx_bakers_city ON baker_network.bakers(city);`)
    await queryRunner.query(`CREATE INDEX idx_bakers_pincode ON baker_network.bakers(pincode);`)
    await queryRunner.query(`CREATE INDEX idx_bakers_status ON baker_network.bakers(status);`)
    await queryRunner.query(`CREATE INDEX idx_bakers_is_public ON baker_network.bakers(is_public);`)
    await queryRunner.query(
      `CREATE INDEX idx_bakers_serviceable_pincodes ON baker_network.bakers USING GIN(serviceable_pincodes);`
    )
    await queryRunner.query(
      `CREATE INDEX idx_bakers_specialty_tags ON baker_network.bakers USING GIN(specialty_tags);`
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.bakers;`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS baker_network;`)
  }
}
