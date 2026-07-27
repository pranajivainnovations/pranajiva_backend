import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Adds the compiled image-generation prompt to ai_studio.cake_designs so it
 * can be surfaced publicly (Showcase Gallery, own-session results, lightbox)
 * — letting visitors see and reuse the exact prompt that produced a design,
 * not just the customer's raw input. Nullable/backfill-free: existing rows
 * simply have no prompt to reveal, which the UI treats as "nothing to show."
 */
export class AddCompiledPromptToCakeDesigns1721950000000 implements MigrationInterface {
  name = "AddCompiledPromptToCakeDesigns1721950000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_studio.cake_designs
        ADD COLUMN IF NOT EXISTS compiled_prompt TEXT;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_studio.cake_designs
        DROP COLUMN IF EXISTS compiled_prompt;
    `)
  }
}
