import { MigrationInterface, QueryRunner } from "typeorm"

import { META_SCHEMA_SQL } from "../services/meta/schema-sql"

/**
 * The `meta` schema — every Meta integration (Instagram now, Facebook Pages and WhatsApp next) and
 * its automation, in one namespace apart from the shop's own tables. See services/meta/schema-sql.ts
 * for the tables and why each exists.
 *
 * Additive only; nothing outside `meta` is touched. Down drops the schema and everything in it.
 */
export class CreateMetaIntegrations1729400000000 implements MigrationInterface {
  name = "CreateMetaIntegrations1729400000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(META_SCHEMA_SQL)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS meta CASCADE`)
  }
}
