import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * AI Studio designs stop being published to the public community gallery automatically.
 *
 * `ai_studio.cake_designs.is_public` defaulted to true and nothing ever set it explicitly, so every
 * design a customer generated went straight into the public showcase — prompt included, via
 * PromptReveal. Those prompts routinely carry the recipient's name and the occasion ("Happy birthday
 * Priya", "for our anniversary"), which makes a surprise cake not much of a surprise, and makes the
 * gallery a feed of other people's personal messages.
 *
 * Sharing is now opt-in: designs are private on creation and the customer publishes one deliberately
 * (see POST /store/ai-studio/designs/:id/visibility).
 *
 * Deliberately does NOT retro-privatise the designs already out there. Flipping those would empty the
 * community gallery of everything it has, which is a business call rather than a migration's to make.
 * They can be bulk-updated separately if that's wanted.
 */
export class DesignsPrivateByDefault1723200000000 implements MigrationInterface {
  name = "DesignsPrivateByDefault1723200000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE ai_studio.cake_designs ALTER COLUMN is_public SET DEFAULT false`
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE ai_studio.cake_designs ALTER COLUMN is_public SET DEFAULT true`
    )
  }
}
