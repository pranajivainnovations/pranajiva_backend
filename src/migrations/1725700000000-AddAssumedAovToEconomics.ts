import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * An order value to measure guardrails against — GS-3.3.
 *
 * ── Why economics needs it ─────────────────────────────────────────────────────────────────────
 * Every interesting guardrail is a comparison against the value of an order. "Do joining cash,
 * cashback and a referral payout together exceed the margin?" has no answer in the abstract — at
 * ₹300 the referral cap barely binds and at ₹3,000 it dominates. The same figure is what makes the
 * live preview in OPS say anything at all: "an ₹800 order with everything firing leaves you ₹X".
 *
 * ── Why a new version rather than an edit ──────────────────────────────────────────────────────
 * Because the table forbids editing, and rightly. This is the first real use of that: the seeded
 * version 1 stays exactly as it was, version 2 supersedes it from now, and the pair is the audit
 * trail for a figure that is about to be argued about.
 *
 * ── Why ₹800, and why it is wrong ──────────────────────────────────────────────────────────────
 * It is the spec's working assumption and nothing more. Real average order value is one of the four
 * figures the whole model waits on. Seeded so the guardrails have something to refuse against —
 * with no AOV they would silently pass everything, which is worse than being provisionally wrong —
 * and labelled in the note so that nobody mistakes it for a measurement.
 */
export class AddAssumedAovToEconomics1725700000000 implements MigrationInterface {
  name = "AddAssumedAovToEconomics1725700000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO wallet.reward_config (brand, mechanic, version, is_enabled, params, note)
      SELECT
        c.brand,
        'economics',
        (SELECT COALESCE(MAX(version), 0) + 1
           FROM wallet.reward_config x
          WHERE x.brand = c.brand AND x.mechanic = 'economics' AND x.pincode IS NULL),
        TRUE,
        c.params || jsonb_build_object('assumed_aov_paise', 80000),
        'PLACEHOLDER — adds an assumed ₹800 average order value so the guardrails have something to measure against. Margin and cap carried forward unchanged from version 1; all three are the spec''s working assumptions, not measured figures.'
      FROM (
        SELECT DISTINCT ON (brand) brand, params
          FROM wallet.reward_config
         WHERE mechanic = 'economics' AND pincode IS NULL
         ORDER BY brand, version DESC
      ) c;
    `)
  }

  /**
   * Removes only the version this migration added, leaving version 1 in place. A blanket delete of
   * economics rows would take the seeded baseline with it and leave the guardrails with nothing to
   * measure against — which fails open, the one direction a guardrail must never fail.
   *
   * The append-only trigger has to be lifted to do it, and this is precisely the case its own
   * comment describes: a deliberate decision that a row must go, taken with intent rather than
   * typed by reflex. It is restored in the same transaction, so a failure part-way through leaves
   * the table protected rather than open.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE wallet.reward_config DISABLE TRIGGER reward_config_append_only;`
    )
    await queryRunner.query(`
      DELETE FROM wallet.reward_config
       WHERE mechanic = 'economics'
         AND pincode IS NULL
         AND params ? 'assumed_aov_paise';
    `)
    await queryRunner.query(
      `ALTER TABLE wallet.reward_config ENABLE TRIGGER reward_config_append_only;`
    )
  }
}
