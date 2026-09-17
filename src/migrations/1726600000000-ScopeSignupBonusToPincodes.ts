import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The welcome bonus can choose where it runs after all.
 *
 * ── Why it could not, a day ago ────────────────────────────────────────────────────────────────
 * It pays the moment somebody joins, and a customer had no pincode until their first order — so
 * there was nothing to match a scope against, and a targeting rule that silently applied to nobody
 * would have been worse than no targeting at all. The columns were refused for that reason.
 *
 * ── What changed ──────────────────────────────────────────────────────────────────────────────
 * The storefront now asks every arriving visitor for their pincode, so by the time they sign in we
 * usually know where they are. It is a declared area rather than a verified address, which is
 * exactly enough for deciding what to offer somebody and deliberately not enough to decide a payout:
 * everything that pays on delivery still reads the real address from the order.
 *
 * ── What happens to a visitor who skipped the question ─────────────────────────────────────────
 * They get nothing, when the bonus is scoped to selected pincodes. That is the agreed rule and it is
 * the honest one — an offer that runs in three pincodes cannot be handed to somebody who might be
 * anywhere. Setting the scope to every pincode is how you choose the opposite.
 */
export class ScopeSignupBonusToPincodes1726600000000 implements MigrationInterface {
  name = "ScopeSignupBonusToPincodes1726600000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /* It is an ordinary serving mechanic now: it may carry a scope, and it may be overridden for
         one pincode like any other. */
      ALTER TABLE wallet.reward_config
        DROP CONSTRAINT IF EXISTS reward_config_signup_scope_ck;

      /* And it must say where it runs, like any other. Economics remains the only exemption, because
         it is the brand's numbers rather than an offer. */
      ALTER TABLE wallet.reward_config DROP CONSTRAINT reward_config_scope_required_ck;
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_scope_required_ck
        CHECK (
          pincode IS NOT NULL
          OR mechanic = 'economics'
          OR scope_mode IS NOT NULL
        );
    `)

    /**
     * Any welcome bonus configured in the day it was brand-only is made explicit.
     *
     * It ran everywhere, so it is recorded as running everywhere rather than being narrowed by a
     * migration — changing what live configuration does is not a migration's decision to take. The
     * trigger is suspended for the same reason the scope migration suspended it: this fills in a
     * column that did not exist, with the answer the row already implied.
     */
    await queryRunner.query(
      `ALTER TABLE wallet.reward_config DISABLE TRIGGER reward_config_append_only`
    )
    await queryRunner.query(`
      UPDATE wallet.reward_config
         SET scope_mode = 'all'
       WHERE mechanic = 'signup_bonus' AND pincode IS NULL AND scope_mode IS NULL;
    `)
    await queryRunner.query(
      `ALTER TABLE wallet.reward_config ENABLE TRIGGER reward_config_append_only`
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_signup_scope_ck
        CHECK (
          mechanic <> 'signup_bonus'
          OR (pincode IS NULL AND scope_mode IS NULL AND scope_pincodes IS NULL)
        );
    `)
  }
}
