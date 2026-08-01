import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Real per-user accounts for the internal ops tool (separate small app,
 * own subdomain — not bolted onto the storefront or Medusa admin). Lives in
 * baker_network since that's the schema the ops tool operates on; this
 * table just happens to be about who's allowed to operate on it, not about
 * bakers themselves.
 */
export class CreateOpsUsers1722400000000 implements MigrationInterface {
  name = "CreateOpsUsers1722400000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE baker_network.ops_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.ops_users;`)
  }
}
