import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Letting credit be spent before the order exists — GS-4.3.
 *
 * ── The problem this solves ────────────────────────────────────────────────────────────────────
 * A customer applies their credit at checkout and the amount they are charged drops immediately.
 * The wallet has to be debited at that moment, not when the order appears: between the two there is
 * a window in which the balance can fall — another tab, an expiry, a clawback — and a debit that
 * fails after the discount has been given means we charged less than we recorded, silently, with no
 * way to notice.
 *
 * But an entry could only point at an order, and at that moment there is no order. So it points at
 * the cart instead.
 *
 * ── Why the row is never promoted to carry the order id ────────────────────────────────────────
 * The obvious move is to fill in order_id once the order exists. The ledger is append-only and
 * refuses UPDATE, and that is not an obstacle to work around — it is the property that makes the
 * history trustworthy. It is also unnecessary: a Medusa order records the cart it came from, so
 * "which order did this redemption pay for" is a join, and one that stays correct without anything
 * having to run at the right moment.
 *
 * ── Why there is no unique index on cart_id ────────────────────────────────────────────────────
 * The rule is "at most one redemption on a cart that has not been reversed", and a unique index
 * cannot say "that has not been reversed" — it would also refuse a customer who removed their credit
 * and applied it again, which is an ordinary thing to do. The apply path takes an advisory lock on
 * the cart and checks, the same shape the referral attribution uses for the same reason.
 */
export class AddCartIdToWalletEntries1726300000000 implements MigrationInterface {
  name = "AddCartIdToWalletEntries1726300000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.entries ADD COLUMN cart_id text;

      /* Only a redemption is written against a cart, and only a reversal undoes one. A grant belongs
         to a delivered order and can never be earned by a cart that may never become one. */
      ALTER TABLE wallet.entries
        ADD CONSTRAINT wallet_entries_cart_type_ck
          CHECK (
            cart_id IS NULL
            OR entry_type IN ('redemption', 'reversal')
          );

      /* The lookup the checkout performs on every render: what has this cart already spent. */
      CREATE INDEX wallet_entries_cart
        ON wallet.entries (cart_id)
        WHERE cart_id IS NOT NULL;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS wallet.wallet_entries_cart;
      ALTER TABLE wallet.entries
        DROP CONSTRAINT IF EXISTS wallet_entries_cart_type_ck,
        DROP COLUMN IF EXISTS cart_id;
    `)
  }
}
