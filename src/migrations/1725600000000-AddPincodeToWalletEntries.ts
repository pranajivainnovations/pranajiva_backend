import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Where a reward was earned — GS-3.2.
 *
 * ── Why the ledger needs this ──────────────────────────────────────────────────────────────────
 * Two of the four limiters count: at most N grants, at most ₹X issued. Both are scoped to a
 * pincode, because the whole launch plan is one pincode at a time with its own budget. Without the
 * pincode on the entry there is nothing to count — a per-pincode budget could only be enforced by
 * joining every grant back to its order and reading the delivery address, which does not exist at
 * all for a manual goodwill grant and is a different answer for an order delivered somewhere other
 * than where the customer signed up.
 *
 * ── Why now ────────────────────────────────────────────────────────────────────────────────────
 * The table is empty. Adding a column to a ledger holding real balances means a backfill whose
 * source is the join described above — the one that is wrong for exactly the rows that matter. The
 * cost of this is zero today and rises with the first grant ever issued.
 *
 * Nullable, because not every entry has a place. A redemption happens wherever the customer is
 * spending, a manual grant is an act of support with no location, and an expiry is a date passing.
 * Only the three reward types are scoped, and the grant engine is what guarantees they carry it —
 * a CHECK cannot, because whether a mechanic is pincode-scoped is a property of its configuration
 * rather than of the row.
 */
export class AddPincodeToWalletEntries1725600000000 implements MigrationInterface {
  name = "AddPincodeToWalletEntries1725600000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.entries
        ADD COLUMN pincode VARCHAR(6);
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.entries
        ADD CONSTRAINT wallet_entries_pincode_ck
        CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$');
    `)

    /**
     * The limiter's access path: everything issued for one mechanic, in one place, since a date.
     *
     * Partial, because the question is only ever asked about grants — a redemption has no budget to
     * count against. Keyed by brand first since that is always known, then pincode, then type.
     */
    await queryRunner.query(`
      CREATE INDEX wallet_entries_scope_usage
        ON wallet.entries (brand, pincode, entry_type, created_at)
        WHERE entry_type IN ('promo_grant', 'referral_earn', 'cashback_earn');
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS wallet.wallet_entries_scope_usage;`)
    await queryRunner.query(
      `ALTER TABLE wallet.entries DROP CONSTRAINT IF EXISTS wallet_entries_pincode_ck;`
    )
    await queryRunner.query(`ALTER TABLE wallet.entries DROP COLUMN IF EXISTS pincode;`)
  }
}
