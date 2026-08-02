import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Vendor-facing images for the future public baker/vendor page (Phase 3 — page design itself is
 * separate, this just lays the storage groundwork). A dedicated table rather than columns on
 * `bakers`: `profile` and `banner` are single-image-per-purpose (always show the most recently
 * uploaded one — old ones are never deleted, just superseded, same "never discard" approach used
 * everywhere else this schema), while `generic` naturally needs many rows per baker. New purposes
 * (`internal`, `external`, or anything else) are just a new value in `purpose`, no schema change.
 */
export class CreateBakerImages1722800000000 implements MigrationInterface {
  name = "CreateBakerImages1722800000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_images (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,
        purpose VARCHAR(30) NOT NULL, -- 'profile' | 'banner' | 'generic' | future values
        s3_key TEXT NOT NULL,
        url TEXT NOT NULL,
        original_filename TEXT,
        mime_type VARCHAR(100),
        size_bytes INT,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await queryRunner.query(`CREATE INDEX idx_baker_images_baker ON baker_network.baker_images(baker_id, purpose);`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_images;`)
  }
}
