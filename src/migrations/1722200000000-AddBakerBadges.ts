import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Two independent, customer-facing trust signals — deliberately separate from
 * `status` (which is internal CRM pipeline state, never shown to customers):
 *
 *  - blue_tick: baker has built their own public store page and uploaded
 *    their own products. Earning this depends on the Phase 3 self-serve
 *    storefront feature, which doesn't exist yet — until it does, this is an
 *    ops-set manual flag, not something a baker can trigger themselves.
 *  - trust_badge: baker has formally affiliated/partnered with CrossFriend
 *    (Flow A/B eligible — we can route real orders to them), as opposed to a
 *    Flow C referral-only listing with no formal relationship.
 *
 * A baker can have neither, either, or both.
 */
export class AddBakerBadges1722200000000 implements MigrationInterface {
  name = "AddBakerBadges1722200000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE baker_network.bakers
        ADD COLUMN blue_tick BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN blue_tick_granted_at TIMESTAMPTZ,
        ADD COLUMN trust_badge BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN trust_badge_granted_at TIMESTAMPTZ;
    `)

    await queryRunner.query(`CREATE INDEX idx_bakers_blue_tick ON baker_network.bakers(blue_tick);`)
    await queryRunner.query(`CREATE INDEX idx_bakers_trust_badge ON baker_network.bakers(trust_badge);`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS baker_network.idx_bakers_blue_tick;`)
    await queryRunner.query(`DROP INDEX IF EXISTS baker_network.idx_bakers_trust_badge;`)
    await queryRunner.query(`
      ALTER TABLE baker_network.bakers
        DROP COLUMN IF EXISTS blue_tick,
        DROP COLUMN IF EXISTS blue_tick_granted_at,
        DROP COLUMN IF EXISTS trust_badge,
        DROP COLUMN IF EXISTS trust_badge_granted_at;
    `)
  }
}
