import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * A baker's working state on an order.
 *
 * Medusa already tracks what an order IS — money, customer, address, fulfilment, payment. What it has
 * no place for is what the baker is DOING: accepted it, started baking, it's ready. Those are not
 * Medusa fulfilment states and forcing them into `fulfillment_status` would lose the meaning of both.
 *
 * ── One row per (order, baker), not per order ───────────────────────────────────────────────────
 * The expectation is one baker per order, with anything else in the basket being add-ons that no
 * baker touches. This table does not assume that. If an order ever does contain two bakers' items,
 * it gets two rows, each baker sees their own items, and OPS sees both — instead of the pipeline
 * resolving to one arbitrary baker or failing outright.
 *
 * That is deliberate: this table's job is to REPORT what is in an order, not to enforce what should
 * be. Whether a cart may hold two bakers is a separate product decision, and when it is made this
 * pipeline keeps working either way. A second row appearing is itself the signal that the cart rule
 * needs attention.
 *
 * ── Why rows are created lazily ─────────────────────────────────────────────────────────────────
 * Nothing writes here at checkout. An order's bakers are derived from its line items on read — from
 * `line_item.metadata->>'bakerId'` for AI Studio cakes, and from baker_products for Ready to Order —
 * so an order is visible to the right baker the moment it is placed, with no event subscriber to
 * miss it and no backfill for orders that predate this table. A row is written the first time a
 * status actually changes; until then the baker's status is 'new' by definition.
 *
 * ── No foreign key to public."order" ────────────────────────────────────────────────────────────
 * Same reasoning as baker_products: Medusa owns that table's migration lifecycle, and a cross-schema
 * FK would couple our migrations to theirs and make Medusa's own deletion paths fail in ways its
 * code does not expect.
 */
export class CreateBakerOrders1724000000000 implements MigrationInterface {
  name = "CreateBakerOrders1724000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS baker_network.baker_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        order_id VARCHAR(255) NOT NULL,
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,

        -- Kept short on purpose: everything up to delivery and nothing beyond it. Returns, refunds,
        -- swaps and partial fulfilment stay in Medusa admin until a real customer needs them.
        -- 'rejected' hangs off 'new' because a baker who cannot take an order needs to say so fast,
        -- and that is the state ops most needs to see.
        status VARCHAR(20) NOT NULL DEFAULT 'new'
          CHECK (status IN ('new', 'accepted', 'baking', 'ready', 'delivered', 'rejected')),

        -- Individually timestamped rather than derived from an audit log: "how long has this been
        -- sitting unaccepted" is the question ops will ask most, and it should be one column, not a
        -- join. NULL means that step has not happened.
        accepted_at   TIMESTAMPTZ,
        baking_at     TIMESTAMPTZ,
        ready_at      TIMESTAMPTZ,
        delivered_at  TIMESTAMPTZ,
        rejected_at   TIMESTAMPTZ,
        rejection_reason TEXT,

        -- Who moved it. Nullable because ops can move an order on a baker's behalf (a phone call),
        -- in which case no baker user was involved.
        updated_by_baker_user UUID REFERENCES baker_network.baker_users(id) ON DELETE SET NULL,
        updated_by_ops_user   UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- One working state per baker per order. This is what makes the lazy upsert safe: two
        -- concurrent status changes collide on the constraint rather than creating two histories.
        UNIQUE (order_id, baker_id)
      )
    `)

    // Covers the portal's only list query: this baker's orders, newest first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_baker_orders_baker
        ON baker_network.baker_orders (baker_id, created_at DESC)
    `)

    // Covers the OPS reverse lookup: given an order, which bakers are on it.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_baker_orders_order
        ON baker_network.baker_orders (order_id)
    `)

    // Covers "what is waiting on someone" — the ops queue view.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_baker_orders_open
        ON baker_network.baker_orders (status, created_at)
        WHERE status IN ('new', 'accepted', 'baking', 'ready')
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_orders`)
  }
}
