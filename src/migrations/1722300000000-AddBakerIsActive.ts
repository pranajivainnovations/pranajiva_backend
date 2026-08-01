import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Soft-offboarding switch — separate from `status` (the CRM pipeline stage)
 * and from `is_public` (the Phase 3 directory-visibility flag). A vendor can
 * be fully onboarded and public, then later paused (bad reviews, temporarily
 * unavailable, dispute) without losing any of their history — is_active just
 * controls whether they're shown/assignable right now. Defaults true so
 * every existing and newly-inserted row stays visible unless explicitly
 * turned off.
 */
export class AddBakerIsActive1722300000000 implements MigrationInterface {
  name = "AddBakerIsActive1722300000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE baker_network.bakers
        ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
    `)
    await queryRunner.query(`CREATE INDEX idx_bakers_is_active ON baker_network.bakers(is_active);`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS baker_network.idx_bakers_is_active;`)
    await queryRunner.query(`ALTER TABLE baker_network.bakers DROP COLUMN IF EXISTS is_active;`)
  }
}
