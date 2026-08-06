import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Generic product-configuration constraints engine — answers "what combinations are allowed" for any
 * category (cake today, others later), completely independent of `pricing` (which answers "how much").
 * Own schema, own draft/published/archived versioning (same lifecycle as `pricing.rule_sets`, but a
 * fully separate table/schema — publishing here never touches a pricing rule set and vice versa).
 * Both schemas share the underlying `pricing.attributes`/`pricing.attribute_values` catalog, since that
 * catalog is genuinely the shared "configurable option" list, not pricing-owned.
 *
 * A rule optionally triggers on another attribute's value (`trigger_attribute_id` + `trigger_operator`
 * + trigger values/numeric bound; NULL trigger_attribute_id = always active) and, once triggered,
 * constrains a target attribute via `kind`: MIN_VALUE/MAX_VALUE (numeric bound), ALLOWED_VALUES/
 * FORBIDDEN_VALUES (a value set), or RECOMMENDED_VALUES (informational only, never blocks).
 *
 * No UUID array columns — target values (`rule_values`) and trigger values (`rule_trigger_values`) are
 * both normalized join tables against `pricing.attribute_values`, so every value reference is a real,
 * FK-enforced row, never a raw string or an unconstrained array element.
 *
 * Evaluation (see src/services/constraints/constraint-engine.ts) independently checks every triggered
 * rule and unions the disables — mathematically equivalent to intersecting numeric bounds and letting
 * "forbidden" win, without a separate conflict-merge step. `priority` only affects which rule's message
 * is surfaced first, never which rule "wins."
 */
export class CreateConstraintsSchema1723100000000 implements MigrationInterface {
  name = "CreateConstraintsSchema1723100000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS constraints;`)

    await queryRunner.query(`
      CREATE TABLE constraints.rule_sets (
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
      CREATE TABLE constraints.rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_set_id UUID NOT NULL REFERENCES constraints.rule_sets(id) ON DELETE CASCADE,

        -- Trigger condition. NULL trigger_attribute_id = unconditional (always active).
        trigger_attribute_id UUID REFERENCES pricing.attributes(id),
        trigger_operator VARCHAR(20) CHECK (trigger_operator IN ('EQUALS', 'NOT_EQUALS', 'IN', 'NOT_IN', 'MIN_VALUE', 'MAX_VALUE')),
        trigger_numeric_value NUMERIC(10, 2),   -- used when trigger_operator IN ('MIN_VALUE','MAX_VALUE')

        -- Target constraint.
        target_attribute_id UUID NOT NULL REFERENCES pricing.attributes(id),
        kind VARCHAR(20) NOT NULL CHECK (kind IN ('MIN_VALUE', 'MAX_VALUE', 'ALLOWED_VALUES', 'FORBIDDEN_VALUES', 'RECOMMENDED_VALUES')),
        numeric_value NUMERIC(10, 2),           -- used when kind IN ('MIN_VALUE','MAX_VALUE')

        message TEXT NOT NULL,
        priority INT NOT NULL DEFAULT 0,        -- message display order only, never conflict resolution
        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by UUID REFERENCES baker_network.ops_users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await queryRunner.query(`CREATE INDEX idx_constraint_rules_rule_set ON constraints.rules(rule_set_id);`)
    await queryRunner.query(`CREATE INDEX idx_constraint_rules_trigger_attr ON constraints.rules(trigger_attribute_id);`)
    await queryRunner.query(`CREATE INDEX idx_constraint_rules_target_attr ON constraints.rules(target_attribute_id);`)

    await queryRunner.query(`
      CREATE TABLE constraints.rule_values (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id UUID NOT NULL REFERENCES constraints.rules(id) ON DELETE CASCADE,
        attribute_value_id UUID NOT NULL REFERENCES pricing.attribute_values(id) ON DELETE CASCADE,
        UNIQUE(rule_id, attribute_value_id)
      );
    `)

    await queryRunner.query(`
      CREATE TABLE constraints.rule_trigger_values (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id UUID NOT NULL REFERENCES constraints.rules(id) ON DELETE CASCADE,
        attribute_value_id UUID NOT NULL REFERENCES pricing.attribute_values(id) ON DELETE CASCADE,
        UNIQUE(rule_id, attribute_value_id)
      );
    `)

    // Forward-looking flag for OPS: does changing this attribute invalidate an already-generated AI
    // image? Column only in this pass — actual enforcement has no hook to attach to yet (product-save
    // doesn't invoke generation), left for later.
    await queryRunner.query(`
      ALTER TABLE pricing.attributes ADD COLUMN requires_regeneration BOOLEAN NOT NULL DEFAULT false;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE pricing.attributes DROP COLUMN IF EXISTS requires_regeneration;`)
    await queryRunner.query(`DROP TABLE IF EXISTS constraints.rule_trigger_values;`)
    await queryRunner.query(`DROP TABLE IF EXISTS constraints.rule_values;`)
    await queryRunner.query(`DROP TABLE IF EXISTS constraints.rules;`)
    await queryRunner.query(`DROP TABLE IF EXISTS constraints.rule_sets;`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS constraints;`)
  }
}
