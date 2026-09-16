import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Which delivery address a reward went to — GS-4.2.
 *
 * ── Why the ledger carries this ────────────────────────────────────────────────────────────────
 * "One grant per delivery address" needs somewhere to ask the question, and the honest place is
 * beside the grant itself: the check is "has this address already had one", and the answer has to
 * survive the order being archived, the customer being deleted, and the address being edited
 * afterwards. Reading it back from the order at grant time would answer a different question — what
 * the address says now — and a fraudster editing an address after delivery would clear the record.
 *
 * ── What is stored, and what is not ────────────────────────────────────────────────────────────
 * A salted digest, never the address. Comparing addresses needs only equality, and keeping the text
 * would copy personal data into a financial table that nobody thinks of as holding any. The salt
 * lives in the environment, so the column cannot be checked against a guessed address by anybody who
 * obtains the table.
 *
 * Nullable, because most entries have no address at all: a redemption happens wherever the customer
 * is spending, an expiry is a date passing, and a manual grant is an act of support. Only the three
 * reward types carry one, and only when the order had an address complete enough to identify.
 */
export class AddAddressHashToWalletEntries1726000000000 implements MigrationInterface {
  name = "AddAddressHashToWalletEntries1726000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.entries
        ADD COLUMN address_hash VARCHAR(64);
    `)

    /**
     * The dedupe lookup: has this address already had this kind of reward on this brand.
     *
     * Partial, because the question is only ever asked about grants — a redemption has no address
     * to be deduped against. Brand is included because the two storefronts run separate offers, and
     * taking joining cash on one should not silently disqualify an address from the other.
     */
    await queryRunner.query(`
      CREATE INDEX wallet_entries_address_grants
        ON wallet.entries (brand, entry_type, address_hash)
        WHERE address_hash IS NOT NULL
          AND entry_type IN ('promo_grant', 'referral_earn', 'cashback_earn');
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS wallet.wallet_entries_address_grants;`)
    await queryRunner.query(`ALTER TABLE wallet.entries DROP COLUMN IF EXISTS address_hash;`)
  }
}
