import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Our own cart and order.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────────
 * Medusa's pipeline models "buy listed things at listed prices, minus coupons". The real transaction
 * is "commission a made-to-order thing at a computed price, part-paid with stored credit, routed to
 * a baker". Saying the second in the first language cost two standing hacks: a draft product and
 * variant fabricated per design so that something could be added to a cart, and a gift card minted
 * per redemption so that credit could be expressed as a discount.
 *
 * Both of those live in the CART, not the order — a design needs a variant because `addItem` takes a
 * variantId. So the cart is the thing worth owning, and the order follows from it.
 *
 * ── What is deliberately not here ──────────────────────────────────────────────────────────────
 * Products, customers, auth and regions stay on Medusa. They are not what hurts, and everything
 * built so far — wallet, studio, referrals, constraints — hangs off `customer_id` from the Medusa
 * token. `cart_items.ref_id` points into Medusa for catalogue items and into ai_studio for designs,
 * and neither is a foreign key for the same reason the rest of our schemas avoid them: these tables
 * must not be coupled to Medusa's migration history.
 *
 * ── Money ──────────────────────────────────────────────────────────────────────────────────────
 * Every amount is an integer of paise. The pricing engine returns RUPEES (`500.00`), so the one
 * conversion — `Math.round(total * 100)` — happens at the service boundary and never again. A
 * float anywhere below this line is a bug.
 */
export class CreateOrdersSchema1727000000000 implements MigrationInterface {
  name = "CreateOrdersSchema1727000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS orders;`)

    /**
     * Order numbers customers can read out on the phone.
     *
     * Starting at 1000 so ours can never be confused with a Medusa order number while both exist —
     * Medusa's are in the 200s and climbing.
     */
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS orders.order_display_seq START 1000;`)

    await queryRunner.query(`
      CREATE TABLE orders.carts (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        /* Nullable: somebody can fill a cart before signing in. Required by the time an order is
           created, which is where the check belongs — asking for a login to hold a cake hostage is
           how a cart gets abandoned. */
        customer_id  character varying,
        brand        character varying NOT NULL,

        /* What the price was computed against. Held on the cart rather than re-read per item so
           every line agrees about where it is going. */
        pincode      character varying,

        status       character varying NOT NULL DEFAULT 'active',
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT carts_brand_ck  CHECK (brand IN ('crossfriend', 'pranajiva')),
        CONSTRAINT carts_status_ck CHECK (status IN ('active', 'ordered', 'abandoned'))
      );
    `)

    /* One active cart per customer per brand. A signed-in customer with two active carts is a
       support conversation about a cake that vanished. Guest carts are keyed by the cookie instead
       and so are excluded. */
    await queryRunner.query(`
      CREATE UNIQUE INDEX carts_one_active_per_customer
        ON orders.carts (customer_id, brand)
        WHERE status = 'active' AND customer_id IS NOT NULL;
    `)

    await queryRunner.query(`
      CREATE TABLE orders.cart_items (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cart_id             uuid NOT NULL REFERENCES orders.carts(id) ON DELETE CASCADE,

        /**
         * The whole idea of this rebuild.
         *
         * 'catalogue'      ref_id -> a Medusa variant id. Pranajiva's products, cake add-ons.
         * 'studio_design'  ref_id -> an ai_studio design id, with the build in spec.
         *
         * A studio cake is a cart item. It is not, and must never again become, a product.
         */
        kind                character varying NOT NULL,
        ref_id              character varying NOT NULL,

        qty                 integer NOT NULL DEFAULT 1,

        /* Frozen at add time from the pricing engine. Never recomputed on read — a rule changed
           tomorrow must not silently restate what somebody was quoted today. */
        unit_price_paise    integer NOT NULL,

        /* What was asked for: weight, tiers, flavour, message, the compiled prompt. Free-form
           because the question "what did they order" has to survive the catalogue changing shape. */
        spec                jsonb NOT NULL DEFAULT '{}'::jsonb,

        /* The receipt for the price above — pricing.price_evaluations row that produced it. */
        price_evaluation_id uuid,

        /* Null until OPS assigns. Held per item because two cakes on one order can go to two bakers. */
        baker_id            character varying,

        created_at          timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT cart_items_kind_ck  CHECK (kind IN ('catalogue', 'studio_design')),
        CONSTRAINT cart_items_qty_ck   CHECK (qty > 0 AND qty <= 99),
        CONSTRAINT cart_items_price_ck CHECK (unit_price_paise >= 0)
      );
    `)

    await queryRunner.query(`
      CREATE INDEX cart_items_cart_idx ON orders.cart_items (cart_id);
    `)

    /**
     * The order, created BEFORE payment.
     *
     * This single decision is what removes "do not close or refresh this page". Medusa creates the
     * order at `cart.complete()` — in the browser's return path — so a closed tab leaves a
     * successful Razorpay payment and an abandoned cart with nothing connecting them. Here the order
     * exists first and payment_status moves independently, so the browser coming back is a
     * convenience rather than the only way an order can come into being.
     */
    await queryRunner.query(`
      CREATE TABLE orders.orders (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        display_id            integer NOT NULL DEFAULT nextval('orders.order_display_seq'),

        cart_id               uuid REFERENCES orders.carts(id),
        customer_id           character varying NOT NULL,
        brand                 character varying NOT NULL,

        subtotal_paise        integer NOT NULL,
        /* Always 0 today. The column exists so that charging for delivery later is a function and a
           config row, not a migration and a new shape for every order ever written. */
        delivery_paise        integer NOT NULL DEFAULT 0,
        credit_applied_paise  integer NOT NULL DEFAULT 0,
        payable_paise         integer NOT NULL,

        razorpay_order_id     character varying,
        razorpay_payment_id   character varying,
        payment_status        character varying NOT NULL DEFAULT 'awaiting',

        status                character varying NOT NULL DEFAULT 'placed',

        /* A copy, not a reference. The customer's address at the moment they ordered, which must not
           change because they later edited their address book. */
        address               jsonb NOT NULL,

        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT orders_brand_ck   CHECK (brand IN ('crossfriend', 'pranajiva')),
        CONSTRAINT orders_payment_ck CHECK (payment_status IN ('awaiting', 'paid', 'failed', 'refunded')),
        CONSTRAINT orders_status_ck  CHECK (status IN ('placed', 'accepted', 'making', 'out_for_delivery', 'delivered', 'cancelled')),
        CONSTRAINT orders_totals_ck  CHECK (
          subtotal_paise >= 0 AND delivery_paise >= 0 AND credit_applied_paise >= 0
          AND payable_paise >= 0
          AND payable_paise = subtotal_paise + delivery_paise - credit_applied_paise
        )
      );
    `)

    /**
     * One order per Razorpay order id.
     *
     * This is what makes markOrderPaid() safe to call from two places. The browser's return and the
     * webhook will both fire in the ordinary case, and they must not be able to produce two orders
     * or two payment records between them.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX orders_razorpay_order_uniq
        ON orders.orders (razorpay_order_id)
        WHERE razorpay_order_id IS NOT NULL;

      CREATE INDEX orders_customer_idx ON orders.orders (customer_id, created_at DESC);
      /* The OPS assignment queue: what has been paid for and has nobody making it. */
      CREATE INDEX orders_unassigned_idx ON orders.orders (created_at)
        WHERE status = 'placed';
    `)

    await queryRunner.query(`
      CREATE TABLE orders.order_items (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id            uuid NOT NULL REFERENCES orders.orders(id) ON DELETE CASCADE,

        kind                character varying NOT NULL,
        ref_id              character varying NOT NULL,
        title               text NOT NULL,
        qty                 integer NOT NULL,
        unit_price_paise    integer NOT NULL,
        spec                jsonb NOT NULL DEFAULT '{}'::jsonb,
        price_evaluation_id uuid,
        baker_id            character varying,

        CONSTRAINT order_items_kind_ck CHECK (kind IN ('catalogue', 'studio_design')),
        CONSTRAINT order_items_qty_ck  CHECK (qty > 0)
      );

      CREATE INDEX order_items_order_idx ON orders.order_items (order_id);
    `)

    /**
     * Every movement, append-only.
     *
     * Two jobs. It is the audit trail for "who said this order was delivered, and when", and it is
     * what the MSG91 flows hang off — a row here is the event that sends the customer a message. A
     * status column alone could be edited into any history somebody preferred.
     */
    await queryRunner.query(`
      CREATE TABLE orders.order_events (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id   uuid NOT NULL REFERENCES orders.orders(id) ON DELETE CASCADE,
        status     character varying NOT NULL,
        at         timestamptz NOT NULL DEFAULT now(),

        /* An ops user id, or 'system' when a webhook or a job moved it. */
        actor      character varying NOT NULL,
        note       text
      );

      CREATE INDEX order_events_order_idx ON orders.order_events (order_id, at);
    `)

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION orders.refuse_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION
          'orders.% is append-only: % is not permitted. Write another event instead.',
          TG_TABLE_NAME, TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER order_events_append_only
        BEFORE UPDATE OR DELETE ON orders.order_events
        FOR EACH ROW EXECUTE FUNCTION orders.refuse_mutation();
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* DROP TABLE is DDL — the append-only trigger guards rows, not the table, and goes with it. */
    await queryRunner.query(`DROP TABLE IF EXISTS orders.order_events;`)
    await queryRunner.query(`DROP TABLE IF EXISTS orders.order_items;`)
    await queryRunner.query(`DROP TABLE IF EXISTS orders.orders;`)
    await queryRunner.query(`DROP TABLE IF EXISTS orders.cart_items;`)
    await queryRunner.query(`DROP TABLE IF EXISTS orders.carts;`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS orders.refuse_mutation();`)
    await queryRunner.query(`DROP SEQUENCE IF EXISTS orders.order_display_seq;`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS orders;`)
  }
}
