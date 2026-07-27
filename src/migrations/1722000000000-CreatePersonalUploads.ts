import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Customer-uploaded personal images — reference photos for AI generation
 * (theme inspiration / recreate-this-cake / photo-cake source) and, later,
 * profile images. Deliberately NOT scoped to a generation_id: uploads happen
 * before a generation necessarily exists (a customer uploads a photo while
 * still composing their request), so ownership is tracked by customer_id
 * directly, with generation_id attached later once/if the upload is actually
 * used. See AI-Context/PROJECT-TRACKER/STATUS.md for the storage design.
 */
export class CreatePersonalUploads1722000000000 implements MigrationInterface {
  name = "CreatePersonalUploads1722000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ai_studio.personal_uploads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id VARCHAR(255) NOT NULL,

        -- Set only once the upload is actually consumed by a generation
        generation_id UUID REFERENCES ai_studio.generations(id) ON DELETE SET NULL,

        -- Storage
        s3_key TEXT NOT NULL,
        original_filename TEXT,
        mime_type VARCHAR(100) NOT NULL,
        size_bytes INT NOT NULL,

        -- What the customer intends to do with it
        purpose VARCHAR(30) NOT NULL, -- 'theme_reference' | 'recreate_cake' | 'photo_cake'
        status VARCHAR(20) NOT NULL DEFAULT 'uploaded', -- 'uploaded' | 'used' | 'discarded'

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(`
      CREATE INDEX idx_personal_uploads_customer ON ai_studio.personal_uploads(customer_id);
    `)
    await queryRunner.query(`
      CREATE INDEX idx_personal_uploads_generation ON ai_studio.personal_uploads(generation_id);
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.personal_uploads;`)
  }
}
