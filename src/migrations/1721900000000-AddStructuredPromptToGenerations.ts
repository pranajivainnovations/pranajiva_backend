import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Adds the structured cake-design specification and the fully compiled
 * image-generation prompt to ai_studio.generations, so every generation is
 * reproducible and debuggable after the fact — not just the raw user prompt.
 */
export class AddStructuredPromptToGenerations1721900000000 implements MigrationInterface {
  name = "AddStructuredPromptToGenerations1721900000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_studio.generations
        ADD COLUMN IF NOT EXISTS structured_specification JSONB,
        ADD COLUMN IF NOT EXISTS compiled_prompt TEXT,
        ADD COLUMN IF NOT EXISTS prompt_version VARCHAR(10) NOT NULL DEFAULT 'v1';
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_studio.generations
        DROP COLUMN IF EXISTS structured_specification,
        DROP COLUMN IF EXISTS compiled_prompt,
        DROP COLUMN IF EXISTS prompt_version;
    `)
  }
}
