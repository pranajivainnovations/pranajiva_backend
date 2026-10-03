import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Let the wallet reference an order in either pipeline.
 *
 * ── The bug this fixes ─────────────────────────────────────────────────────────────────────────
 * wallet.entries.order_id carried a foreign key to public."order" — Medusa's table. Ordering moved
 * to orders.orders, so every grant the growth system tried to write against a real order was
 * refused by the database: joining cash, referral commission and cashback alike. Not degraded,
 * refused outright, with the whole subsystem built and correct behind it.
 *
 * It had not surfaced because the subscriber that writes those grants listens for a Medusa event
 * that also stopped happening, so nothing had reached the constraint to fail against it. Fixing the
 * trigger without fixing this would have turned a silent no-op into a nightly error.
 *
 * ── Why the key is dropped rather than repointed ───────────────────────────────────────────────
 * Because it cannot be repointed. A foreign key names one table, and an order id in this column now
 * legitimately refers to a row in either public."order" (everything up to the cutover, including
 * deliveries real referrers are owed commission on) or orders.orders (everything since). Pointing
 * it at the new table would refuse every historical entry; pointing it at the old one is the bug.
 *
 * ── What is lost, and why it is acceptable here ────────────────────────────────────────────────
 * Referential integrity on this column, so in principle a ledger row could name an order that does
 * not exist. In practice neither table has a delete path — orders.orders is written and moved, never
 * removed, and Medusa orders are cancelled rather than deleted — so the dangling reference the key
 * protected against has no way to occur. And the ledger is append-only: a row here is a record that
 * money moved, which stays true even if the order it names were somehow gone. The integrity that
 * actually matters on this table — customer_id, source_entry_id, created_by — is untouched.
 *
 * The index stays. It was never the constraint doing the work for the queries that read by order.
 */
export class WalletOrderIdSpansPipelines1727700000000 implements MigrationInterface {
  name = "WalletOrderIdSpansPipelines1727700000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.entries DROP CONSTRAINT IF EXISTS entries_order_id_fkey;

      /* Reading a customer's grants by order is how both the clawback and the payout engine check
         whether something has already been paid, so the lookup earns its own index now that the
         constraint is not providing one. */
      CREATE INDEX IF NOT EXISTS entries_order_id_idx
        ON wallet.entries (order_id) WHERE order_id IS NOT NULL;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * Deliberately does not restore the key.
     *
     * Any grant written against an order from the new pipeline would make restoring it fail, and a
     * down migration that works only until the feature has been used is worse than one that is
     * honest about being one-way. The index is dropped; the column keeps its meaning.
     */
    await queryRunner.query(`DROP INDEX IF EXISTS wallet.entries_order_id_idx;`)
  }
}
