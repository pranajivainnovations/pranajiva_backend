import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Credit for joining, and credit given by hand.
 *
 * ── Why a signup bonus is not just another joining grant ───────────────────────────────────────
 * Joining cash is two grants and both are earned by ordering. That shape is the reason the offer is
 * safe: a fraudster has to buy a ₹699 cake to extract ₹100, so the attack costs more than it pays.
 * A signup bonus deliberately gives that up — it pays for an account and nothing else — which makes
 * it a different instrument with different bounds, and folding it into promo_grant would have made
 * it silently consume one of the two joining slots.
 *
 * ── Why it can never be scoped to a pincode ────────────────────────────────────────────────────
 * A customer has no pincode until their first order; the address that would give them one does not
 * exist yet. Every other mechanic chooses where it runs, and this one cannot, so the columns are
 * refused rather than left to imply a choice nobody can make. What bounds it instead is the budget,
 * the grant cap and the expiry.
 *
 * ── Why one per customer per brand is an index and not a check in code ─────────────────────────
 * A signup happens once, but the code that reacts to one can run twice — a retried request, a
 * redelivered event, an operator running a backfill. The unique index makes the second write do
 * nothing, in the same way the one-grant-per-order index does for the order-triggered mechanics.
 */
export class AddSignupBonus1726400000000 implements MigrationInterface {
  name = "AddSignupBonus1726400000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /* The ledger learns one new kind of entry. */
      ALTER TABLE wallet.entries DROP CONSTRAINT wallet_entries_type_ck;
      ALTER TABLE wallet.entries ADD CONSTRAINT wallet_entries_type_ck
        CHECK (entry_type IN (
          'promo_grant', 'signup_bonus', 'referral_earn', 'cashback_earn', 'manual_grant',
          'redemption', 'reversal', 'expiry'
        ));

      /* Like every other configured grant, it records which version of the rules issued it. */
      ALTER TABLE wallet.entries DROP CONSTRAINT wallet_entries_config_version_ck;
      ALTER TABLE wallet.entries ADD CONSTRAINT wallet_entries_config_version_ck
        CHECK (
          entry_type NOT IN ('promo_grant', 'signup_bonus', 'referral_earn', 'cashback_earn')
          OR config_version IS NOT NULL
        );

      /* And it may expire, which is the point of it — credit that sits for ever is a liability, and
         a deadline is what turns a signup into an order. */
      ALTER TABLE wallet.entries DROP CONSTRAINT wallet_entries_expiry_ck;
      ALTER TABLE wallet.entries ADD CONSTRAINT wallet_entries_expiry_ck
        CHECK (
          expires_at IS NULL
          OR entry_type IN ('promo_grant', 'signup_bonus', 'referral_earn', 'cashback_earn',
                            'manual_grant')
        );

      /* One per customer per brand, enforced where it cannot be forgotten. */
      CREATE UNIQUE INDEX wallet_entries_one_signup_bonus
        ON wallet.entries (customer_id, brand)
        WHERE entry_type = 'signup_bonus';

      /* Configurable like the others. */
      ALTER TABLE wallet.reward_config DROP CONSTRAINT reward_config_mechanic_ck;
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_mechanic_ck
        CHECK (mechanic IN ('economics', 'signup_bonus', 'joining_cash', 'referral', 'cashback'));

      /* But never scoped, and never overridden per pincode — there is no pincode to key on at the
         moment it pays. Both halves are refused, so neither can be set by mistake and read as a
         targeting rule that is quietly doing nothing. */
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_signup_scope_ck
        CHECK (
          mechanic <> 'signup_bonus'
          OR (pincode IS NULL AND scope_mode IS NULL AND scope_pincodes IS NULL)
        );

      /* The scope requirement above exempts economics; exempt this too, for the same reason. */
      ALTER TABLE wallet.reward_config DROP CONSTRAINT reward_config_scope_required_ck;
      ALTER TABLE wallet.reward_config ADD CONSTRAINT reward_config_scope_required_ck
        CHECK (
          pincode IS NOT NULL
          OR mechanic IN ('economics', 'signup_bonus')
          OR scope_mode IS NOT NULL
        );
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS wallet.wallet_entries_one_signup_bonus;
      ALTER TABLE wallet.reward_config
        DROP CONSTRAINT IF EXISTS reward_config_signup_scope_ck;
    `)
  }
}
