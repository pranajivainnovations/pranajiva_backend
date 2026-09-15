import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Operational switches for the wallet — GS-2.5.
 *
 * ── Why not crossfriend.site_settings ──────────────────────────────────────────────────────────
 * That table is served by an unauthenticated route and its own migration says nothing but public
 * facts may go in it. It also holds contact numbers and social links: a switch that decides whether
 * money is clawed back from a customer does not belong in the same list as the WhatsApp number,
 * where someone tidying up contact details is one field away from it.
 *
 * ── Why not the reward config that GS-3.1 will build ───────────────────────────────────────────
 * That one is versioned and never mutated, because a rate has to stay pinned to the rows it
 * produced — "why did this customer get ₹40" must stay answerable a year later. These are
 * different: they are operational switches with no arithmetic frozen onto anything, and versioning
 * them would imply a history that means nothing. Two small tables with clearly different jobs beats
 * one table that has to explain which of its rows are which.
 */
export class CreateWalletSettings1725400000000 implements MigrationInterface {
  name = "CreateWalletSettings1725400000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallet.settings (
        key        VARCHAR(64) PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    /**
     * What happens when an order is refunded after its reward has already been spent.
     *
     *   write_off       Take back whatever is left of the grant and absorb the rest. The customer
     *                   never sees a negative balance.
     *   allow_negative  Take back the full grant. The unrecovered part becomes a debt that the
     *                   balance carries, so the customer owes it before they can spend again.
     *
     * Seeded to write_off, deliberately. The amounts are small, rewards are only granted seven days
     * past the return window so a later refund is rare, and the alternative puts "−₹40" in front of
     * a customer, which is a support conversation every single time. The other mode is implemented
     * and tested — this is a switch, not a promise of one — so changing it is an UPDATE here.
     */
    await queryRunner.query(`
      INSERT INTO wallet.settings (key, value)
      VALUES ('refund_clawback_policy', 'write_off')
      ON CONFLICT (key) DO NOTHING;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS wallet.settings;`)
  }
}
