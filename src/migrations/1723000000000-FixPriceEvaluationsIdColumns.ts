import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Fix: pricing.price_evaluations.customer_id / order_id were typed UUID, but Medusa's own entity ids
 * are prefixed strings ("order_01...", "cus_01...") — not native Postgres UUIDs. Caught live: the
 * order.placed subscriber that backfills order_id threw "invalid input syntax for type uuid" against
 * a real completed order. No real data at risk — both columns were null on every row up to this point
 * (no order had completed through this pipeline until the test that surfaced the bug).
 */
export class FixPriceEvaluationsIdColumns1723000000000 implements MigrationInterface {
  name = "FixPriceEvaluationsIdColumns1723000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE pricing.price_evaluations ALTER COLUMN customer_id TYPE TEXT;`)
    await queryRunner.query(`ALTER TABLE pricing.price_evaluations ALTER COLUMN order_id TYPE TEXT;`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE pricing.price_evaluations ALTER COLUMN customer_id TYPE UUID USING customer_id::uuid;`)
    await queryRunner.query(`ALTER TABLE pricing.price_evaluations ALTER COLUMN order_id TYPE UUID USING order_id::uuid;`)
  }
}
