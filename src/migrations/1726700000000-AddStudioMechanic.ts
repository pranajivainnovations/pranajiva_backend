import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The AI Studio becomes a configurable mechanic.
 *
 * ── Why it belongs in reward_config at all ─────────────────────────────────────────────────────
 * It issues no credit, so on the face of it the reward tables are the wrong home. What it does share
 * is everything that made those tables worth building: numbers that are money, that an operator must
 * be able to move at 2am without a deploy, that have to be versioned so "why was this customer
 * charged ₹10?" stays answerable, and that need an audit line saying who moved them.
 *
 * Putting it here means the Studio inherits the whole control plane — the versioned editor, the
 * scope picker, the audit log, the global stop — rather than growing a second settings surface with
 * its own half of those features.
 *
 * ── What it deliberately does NOT inherit ──────────────────────────────────────────────────────
 * The grant limiters. `max_grants` and `budget_paise` count rows in wallet.entries, and a generation
 * is not a ledger entry, so those counters would silently report zero for ever. The metering service
 * reads this config directly rather than through evaluateMechanic, and a compute budget — if one is
 * ever wanted — needs its own counter over ai_studio.generations.
 *
 * ── Why the free allowances are configuration and not constants ────────────────────────────────
 * The storefront currently enforces "3 free" with a constant in a React component, which is to say it
 * does not enforce it at all. Replacing that with a constant in the backend would fix the hole and
 * keep the rigidity. At ₹5 of compute a generation, the difference between ten free and four is the
 * difference between spending more than a first order earns and not — and that is a number the
 * business will want to move on a Tuesday, having watched a week of usage.
 */
export class AddStudioMechanic1726700000000 implements MigrationInterface {
  name = "AddStudioMechanic1726700000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config DROP CONSTRAINT reward_config_mechanic_ck;
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_mechanic_ck
        CHECK (mechanic IN ('economics', 'signup_bonus', 'joining_cash', 'referral', 'cashback', 'studio'));
    `)

    /**
     * The Studio is national, so it carries no pincode scope.
     *
     * A cake is delivered to an address; a generated image is not. Scoping generation limits by
     * pincode would be a control nobody could explain — and `scope_required_ck` would otherwise force
     * a scope onto every studio row, because that rule was written when economics was the only
     * mechanic that could go without one.
     */
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config DROP CONSTRAINT reward_config_scope_required_ck;
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_scope_required_ck
        CHECK (
          pincode IS NOT NULL
          OR mechanic IN ('economics', 'studio')
          OR scope_mode IS NOT NULL
        );
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_studio_scope_ck
        CHECK (mechanic <> 'studio' OR (pincode IS NULL AND scope_mode IS NULL AND scope_pincodes IS NULL));
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * The table refuses DELETE — it is append-only, guarded by a trigger, because a config row is
     * the evidence for why a customer was charged what they were charged.
     *
     * Reversing this migration is the one case where removing rows is right rather than wrong: the
     * mechanic itself is going away, and leaving studio rows behind would leave the constraint below
     * unable to be restored. So the guard is suspended for exactly this statement and put back inside
     * the same transaction, which means a failure anywhere in between rolls the suspension back too.
     */
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config DISABLE TRIGGER reward_config_append_only;
      DELETE FROM wallet.reward_config WHERE mechanic = 'studio';
      ALTER TABLE wallet.reward_config ENABLE TRIGGER reward_config_append_only;
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.reward_config DROP CONSTRAINT reward_config_studio_scope_ck;
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.reward_config DROP CONSTRAINT reward_config_scope_required_ck;
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_scope_required_ck
        CHECK (pincode IS NOT NULL OR mechanic = 'economics' OR scope_mode IS NOT NULL);
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.reward_config DROP CONSTRAINT reward_config_mechanic_ck;
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_mechanic_ck
        CHECK (mechanic IN ('economics', 'signup_bonus', 'joining_cash', 'referral', 'cashback'));
    `)
  }
}
