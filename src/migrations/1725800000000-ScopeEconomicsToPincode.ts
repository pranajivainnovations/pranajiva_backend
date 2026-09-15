import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Let the redemption cap be set per pincode — GS-3.3, revised.
 *
 * ── What changed and why ───────────────────────────────────────────────────────────────────────
 * Economics was brand-level only, on the reasoning that gross margin describes the business rather
 * than a place. That reasoning held for margin and did not hold for the redemption cap, which is an
 * offer decision: how much of an order a customer may pay from their wallet is exactly the sort of
 * thing to loosen in one pincode during a launch and leave alone everywhere else.
 *
 * Rather than splitting the cap into its own table, the constraint relaxes. Economics rows may now
 * carry a pincode and inherit the rest from the brand, which is the same merge every other mechanic
 * already uses — one rule for scoping instead of two.
 *
 * ── What stays forbidden ───────────────────────────────────────────────────────────────────────
 * The four limiters. A margin cannot start on Tuesday, run out of budget, or be capped at 200
 * grants; letting economics carry those columns would invite somebody to set a budget on the gross
 * margin and wonder why nothing happened.
 */
export class ScopeEconomicsToPincode1725800000000 implements MigrationInterface {
  name = "ScopeEconomicsToPincode1725800000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config
        DROP CONSTRAINT reward_config_economics_ck;
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.reward_config
        ADD CONSTRAINT reward_config_economics_ck CHECK (
          mechanic <> 'economics'
          OR (starts_at IS NULL AND ends_at IS NULL
              AND max_grants IS NULL AND budget_paise IS NULL)
        );
    `)
  }

  /**
   * Restoring the stricter constraint would fail if a pincode-scoped economics row exists by then,
   * which is the correct outcome: rolling this back with such a row present would leave a
   * configuration the schema says is impossible. Removing the rows first would silently revert a
   * pincode to the brand's cap, changing what customers can spend without anybody asking.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config
        DROP CONSTRAINT reward_config_economics_ck;
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.reward_config
        ADD CONSTRAINT reward_config_economics_ck CHECK (
          mechanic <> 'economics'
          OR (pincode IS NULL AND starts_at IS NULL AND ends_at IS NULL
              AND max_grants IS NULL AND budget_paise IS NULL)
        );
    `)
  }
}
