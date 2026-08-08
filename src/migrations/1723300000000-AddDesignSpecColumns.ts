import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Records the physical spec a design was generated for — weight, tiers, shape.
 *
 * These were already collected in the studio and already sent to the generator (they shape the image
 * prompt: "three tier", "heart shaped"), but only style/occasion/flavor were ever written to
 * cake_designs. So a design remembered that it was a Realistic Chocolate Birthday cake while forgetting
 * that it was a 3-tier, 2 kg one.
 *
 * That gap is a pricing bug, not just missing metadata. Adopting a community design restored the
 * fields that were stored and left weight and tiers at their defaults — so a customer could adopt a
 * towering 3-tier cake and be quoted the price of a 0.5 kg one, then see a different number again at
 * checkout once the real product was created. The image, the price and the cart disagreed with each
 * other because only one of them knew how big the cake actually was.
 *
 * Nullable on purpose: designs generated before this simply don't know, and the studio falls back to
 * its own defaults for those rather than inventing a spec that was never chosen.
 */
export class AddDesignSpecColumns1723300000000 implements MigrationInterface {
  name = "AddDesignSpecColumns1723300000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_studio.cake_designs
        ADD COLUMN IF NOT EXISTS weight VARCHAR(16),
        ADD COLUMN IF NOT EXISTS tiers VARCHAR(8),
        ADD COLUMN IF NOT EXISTS shape VARCHAR(32)
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_studio.cake_designs
        DROP COLUMN IF EXISTS weight,
        DROP COLUMN IF EXISTS tiers,
        DROP COLUMN IF EXISTS shape
    `)
  }
}
