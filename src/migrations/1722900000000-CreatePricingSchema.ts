import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Configurable pricing engine — replaces the static `ai-cake-studio-config.json` as the source of
 * truth for AI Cake Studio pricing. Same Postgres instance as Medusa/baker_network, own schema since
 * this is a distinct domain (money rules, not baker/vendor data).
 *
 * Full design (schema rationale, resolution algorithm, fallback guarantees, versioning strategy,
 * evaluation order, override behavior): see the approved design doc referenced in
 * AI-Context/PROJECT-TRACKER/STATUS.md → Checkout section.
 *
 * Key invariants encoded here, not just in application code:
 *  - `region_id IS NULL` means "default" (global) — a resolver falls through to it whenever a more
 *    specific region row doesn't exist. A pincode maps to at most one region (`region_pincodes.pincode`
 *    UNIQUE), so there is never a region-vs-region precedence conflict to resolve.
 *  - Postgres treats NULL as distinct from itself in a plain UNIQUE constraint, so a naive
 *    UNIQUE(rule_set_id, weight_value_id, region_id) would silently allow multiple "default" rows for
 *    the same weight. Partial unique indexes (below) close that gap explicitly.
 *  - Published `rule_sets` are meant to be immutable by convention (enforced in application code, not
 *    the DB) — changes always go through a new draft + a new Publish, so `published_by`/`published_at`
 *    on each version doubles as the change-history audit trail without a separate audit-log table.
 */
export class CreatePricingSchema1722900000000 implements MigrationInterface {
  name = "CreatePricingSchema1722900000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS pricing;`)

    await queryRunner.query(`
      CREATE TABLE pricing.product_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(50) UNIQUE NOT NULL,
        label TEXT NOT NULL,
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID REFERENCES baker_network.ops_users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(`
      CREATE TABLE pricing.attributes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id UUID NOT NULL REFERENCES pricing.product_categories(id) ON DELETE CASCADE,
        key VARCHAR(50) NOT NULL,               -- 'weight' | 'flavor' | 'shape' | 'style' | 'tiers' | 'delivery_speed' | ...
        label TEXT NOT NULL,
        input_type VARCHAR(20) NOT NULL DEFAULT 'select',  -- UI hint only, not enforced in logic
        sort_order INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID REFERENCES baker_network.ops_users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(category_id, key)
      );
    `)

    await queryRunner.query(`
      CREATE TABLE pricing.attribute_values (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        attribute_id UUID NOT NULL REFERENCES pricing.attributes(id) ON DELETE CASCADE,
        value VARCHAR(100) NOT NULL,             -- machine key, e.g. '1', 'Chocolate'
        label TEXT NOT NULL,                     -- display label, e.g. '1 Kg', 'Chocolate'
        extra JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"serves":"8-10"} for weight, {"emoji":"🍫"} for flavor
        sort_order INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID REFERENCES baker_network.ops_users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(attribute_id, value)
      );
    `)

    await queryRunner.query(`
      CREATE TABLE pricing.regions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(50) UNIQUE NOT NULL,         -- e.g. 'delhi_premium'
        label TEXT NOT NULL,                     -- e.g. 'Delhi Premium Area'
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID REFERENCES baker_network.ops_users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(`
      CREATE TABLE pricing.region_pincodes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        region_id UUID NOT NULL REFERENCES pricing.regions(id) ON DELETE CASCADE,
        pincode VARCHAR(6) NOT NULL UNIQUE,      -- a pincode belongs to AT MOST ONE region — no ambiguity by construction
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await queryRunner.query(`CREATE INDEX idx_region_pincodes_region ON pricing.region_pincodes(region_id);`)

    await queryRunner.query(`
      CREATE TABLE pricing.rule_sets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id UUID NOT NULL REFERENCES pricing.product_categories(id) ON DELETE CASCADE,
        version INT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        effective_from TIMESTAMPTZ,
        effective_to TIMESTAMPTZ,
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID REFERENCES baker_network.ops_users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_by UUID REFERENCES baker_network.ops_users(id),
        published_at TIMESTAMPTZ,
        UNIQUE(category_id, version)
      );
    `)

    await queryRunner.query(`
      CREATE TABLE pricing.base_price_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_set_id UUID NOT NULL REFERENCES pricing.rule_sets(id) ON DELETE CASCADE,
        weight_value_id UUID NOT NULL REFERENCES pricing.attribute_values(id),
        region_id UUID REFERENCES pricing.regions(id),   -- NULL = default/global
        amount NUMERIC(10, 2) NOT NULL,
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID REFERENCES baker_network.ops_users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    // Partial unique indexes, not a plain UNIQUE(...) — see class comment for why.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_base_price_default ON pricing.base_price_rules(rule_set_id, weight_value_id)
      WHERE region_id IS NULL;
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_base_price_region ON pricing.base_price_rules(rule_set_id, weight_value_id, region_id)
      WHERE region_id IS NOT NULL;
    `)

    await queryRunner.query(`
      CREATE TABLE pricing.adjustment_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_set_id UUID NOT NULL REFERENCES pricing.rule_sets(id) ON DELETE CASCADE,
        attribute_value_id UUID NOT NULL REFERENCES pricing.attribute_values(id),
        region_id UUID REFERENCES pricing.regions(id),   -- NULL = default/global
        calculation_target VARCHAR(20) NOT NULL DEFAULT 'RUNNING_SUBTOTAL'
          CHECK (calculation_target IN ('BASE', 'RUNNING_SUBTOTAL', 'FINAL_TOTAL')),
        adjustment_type VARCHAR(20) NOT NULL CHECK (adjustment_type IN ('flat', 'multiplier', 'per_kg', 'percentage')),
        amount NUMERIC(10, 4) NOT NULL,
        label TEXT,                              -- overrides attribute_value.label for this rule's breakdown line
        display_order INT NOT NULL DEFAULT 0,     -- UI presentation order only
        evaluation_order INT NOT NULL DEFAULT 0,  -- actual math sequence
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID REFERENCES baker_network.ops_users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_adjustment_default ON pricing.adjustment_rules(rule_set_id, attribute_value_id)
      WHERE region_id IS NULL;
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_adjustment_region ON pricing.adjustment_rules(rule_set_id, attribute_value_id, region_id)
      WHERE region_id IS NOT NULL;
    `)

    await queryRunner.query(`
      CREATE TABLE pricing.price_evaluations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_set_id UUID NOT NULL REFERENCES pricing.rule_sets(id),
        region_id UUID REFERENCES pricing.regions(id),
        category_id UUID NOT NULL REFERENCES pricing.product_categories(id),
        pincode VARCHAR(6),                      -- what the customer entered, even if it never mapped to a region
        selections JSONB NOT NULL,                -- raw inputs: weight, flavor, tiers, shape, style, delivery flags, addons
        breakdown JSONB NOT NULL,                 -- ordered [{label, amount, display_order}, ...] exactly as shown
        total_amount NUMERIC(10, 2) NOT NULL,
        customer_id UUID,                         -- nullable — an evaluation can happen before login
        order_id UUID,                            -- filled in once/if this becomes a real order
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await queryRunner.query(`CREATE INDEX idx_price_evaluations_order ON pricing.price_evaluations(order_id);`)
    await queryRunner.query(`CREATE INDEX idx_price_evaluations_customer ON pricing.price_evaluations(customer_id);`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.price_evaluations;`)
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.adjustment_rules;`)
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.base_price_rules;`)
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.rule_sets;`)
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.region_pincodes;`)
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.regions;`)
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.attribute_values;`)
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.attributes;`)
    await queryRunner.query(`DROP TABLE IF EXISTS pricing.product_categories;`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS pricing;`)
  }
}
