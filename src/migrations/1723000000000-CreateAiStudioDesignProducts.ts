import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Links an ai_studio.cake_designs row to the real Medusa product+variant created for it, scoped
 * per-customer (not globally on cake_designs itself) — a showcase-gallery design can be picked by
 * many different customers, and each must get their own product so Medusa's price-derivation-from-
 * variant behavior can never leak one customer's configuration/price onto another's still-open cart.
 *
 * Purpose: given a (design_id, customer_id) pair, /store/ai-studio/product can look up whether this
 * customer already has a product for this design and update it in place instead of creating a
 * duplicate — durable across page reloads, not just React state.
 */
export class CreateAiStudioDesignProducts1723000000000 implements MigrationInterface {
  name = "CreateAiStudioDesignProducts1723000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ai_studio.design_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        design_id UUID NOT NULL REFERENCES ai_studio.cake_designs(id) ON DELETE CASCADE,
        customer_id VARCHAR(255) NOT NULL,
        medusa_product_id VARCHAR(255) NOT NULL,
        medusa_variant_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (design_id, customer_id)
      );
    `)

    await queryRunner.query(`
      CREATE INDEX idx_design_products_customer ON ai_studio.design_products(customer_id);
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.design_products;`)
  }
}
