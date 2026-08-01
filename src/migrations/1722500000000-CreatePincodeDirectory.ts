import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Static India pincode reference data, sourced from the real official India
 * Post Pincode Directory (data.gov.in) — imported via a script in the
 * crossfriend-ops repo, not seeded here. Two tables, deliberately separate:
 *
 *  - pincode_directory: raw import, ~1 row per POST OFFICE (the source file
 *    is one-row-per-office, not one-row-per-pincode — a single pincode
 *    commonly has several offices). Pure reference data — safe to wipe and
 *    reload wholesale if a newer directory file shows up, since nothing we
 *    care about operationally lives here.
 *  - pincode_service_status: our own operational tracking, exactly ONE row
 *    per DISTINCT pincode (not per office). `service_enabled` is the
 *    explicit go-live switch — customers see "coming soon" for a pincode
 *    that's false here, independent of whether any baker actually covers
 *    it yet. Kept separate from pincode_directory on purpose: toggling one
 *    pincode shouldn't mean updating several duplicate office rows and
 *    risking them drifting out of sync, and this table survives untouched
 *    even if pincode_directory gets wiped and reloaded later.
 */
export class CreatePincodeDirectory1722500000000 implements MigrationInterface {
  name = "CreatePincodeDirectory1722500000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE baker_network.pincode_directory (
        id BIGSERIAL PRIMARY KEY,
        circle_name TEXT,
        region_name TEXT,
        division_name TEXT,
        office_name TEXT,
        pincode VARCHAR(6) NOT NULL,
        office_type VARCHAR(10),
        delivery_status VARCHAR(20),
        district TEXT,
        state_name TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await queryRunner.query(`CREATE INDEX idx_pincode_directory_pincode ON baker_network.pincode_directory(pincode);`)
    await queryRunner.query(`CREATE INDEX idx_pincode_directory_district ON baker_network.pincode_directory(district);`)
    await queryRunner.query(
      `CREATE INDEX idx_pincode_directory_office_name ON baker_network.pincode_directory(LOWER(office_name));`
    )

    await queryRunner.query(`
      CREATE TABLE baker_network.pincode_service_status (
        pincode VARCHAR(6) PRIMARY KEY,
        service_enabled BOOLEAN NOT NULL DEFAULT false,
        service_enabled_at TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await queryRunner.query(
      `CREATE INDEX idx_pincode_service_status_enabled ON baker_network.pincode_service_status(service_enabled);`
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.pincode_service_status;`)
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.pincode_directory;`)
  }
}
