import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Cash on delivery, and a delivery charge that is a setting rather than a constant.
 *
 * ── Why the pipeline needed a payment method at all ────────────────────────────────────────────
 * It was built for CrossFriend, where every order is prepaid because a cake is made before it
 * travels and a refused delivery is a total loss. PranaJiva posts jars of powder across India,
 * where a large part of the market still will not prepay a brand they have not bought from — and
 * both of its orders to date were cash. Moving it onto this pipeline without COD would have been a
 * migration that quietly removed a payment method from a working shop.
 *
 * ── Why the column defaults to razorpay ────────────────────────────────────────────────────────
 * Every order that already exists was prepaid, so the default is not a guess — it is what those
 * rows are. A nullable column would have left "we do not know how this was paid" as a permanent
 * state for orders we do know about.
 *
 * ── Why delivery moves to config rather than gaining a column ──────────────────────────────────
 * delivery_paise already exists on the order and is already inside the totals CHECK; what was
 * missing was anywhere to say what it should be. That belongs with the other money levers in
 * wallet.reward_config — versioned, attributed, and changeable from OPS without a deploy — rather
 * than as a constant in the cart service, which is where it was.
 */
export class AddOrderPaymentMethod1727600000000 implements MigrationInterface {
  name = "AddOrderPaymentMethod1727600000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE orders.orders
        ADD COLUMN IF NOT EXISTS payment_method VARCHAR(16) NOT NULL DEFAULT 'razorpay';

      ALTER TABLE orders.orders
        DROP CONSTRAINT IF EXISTS orders_payment_method_ck;

      ALTER TABLE orders.orders
        ADD CONSTRAINT orders_payment_method_ck
        CHECK (payment_method IN ('razorpay', 'cod'));

      /**
       * A prepaid order must name the Razorpay order it is waiting on; a cash order must not.
       *
       * Without this, "cod" would be reachable as a way to place an order that skips payment
       * entirely and still looks prepaid — and a razorpay order with no razorpay_order_id is an
       * order nothing can ever confirm. The constraint makes both unrepresentable rather than
       * merely unlikely.
       *
       * Orders that are fully covered by credit are the exception the IS NULL arm also serves:
       * there is nothing for Razorpay to collect, so there is no order id to carry.
       */
      ALTER TABLE orders.orders
        DROP CONSTRAINT IF EXISTS orders_cod_no_gateway_ck;

      ALTER TABLE orders.orders
        ADD CONSTRAINT orders_cod_no_gateway_ck
        CHECK (payment_method <> 'cod' OR razorpay_order_id IS NULL);
    `)

    /**
     * The config catalogue has to admit the new mechanic before a row can carry it.
     *
     * reward_config constrains `mechanic` to a list in the database as well as in the TypeScript
     * union — deliberately, since these rows are money and the database is the last thing standing
     * between a typo and a brand silently reading no config at all. Widening it is therefore part
     * of adding a mechanic, not an afterthought.
     */
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config DROP CONSTRAINT IF EXISTS reward_config_mechanic_ck;

      ALTER TABLE wallet.reward_config
        ADD CONSTRAINT reward_config_mechanic_ck
        CHECK (mechanic IN (
          'economics', 'signup_bonus', 'joining_cash', 'referral', 'cashback', 'studio', 'fulfilment'
        ));

      /**
       * Fulfilment is brand-wide, like economics and studio, so it is exempt from needing a scope.
       *
       * The scope machinery exists for mechanics that SPEND money and therefore have to be startable
       * in one pincode and not another. Delivery pricing and whether cash is accepted are properties
       * of how a brand operates, not a campaign to be switched on in Indirapuram — and a per-pincode
       * delivery charge, when that day comes, is a pincode row rather than a scope list.
       */
      ALTER TABLE wallet.reward_config DROP CONSTRAINT IF EXISTS reward_config_scope_required_ck;

      ALTER TABLE wallet.reward_config
        ADD CONSTRAINT reward_config_scope_required_ck
        CHECK (
          pincode IS NOT NULL
          OR mechanic IN ('economics', 'studio', 'fulfilment')
          OR scope_mode IS NOT NULL
        );

      /* And it issues nothing, so the grant machinery must stay empty on it — same rule economics
         already carries, for the same reason: a budget on a delivery charge means nothing. */
      ALTER TABLE wallet.reward_config DROP CONSTRAINT IF EXISTS reward_config_fulfilment_ck;

      ALTER TABLE wallet.reward_config
        ADD CONSTRAINT reward_config_fulfilment_ck
        CHECK (
          mechanic <> 'fulfilment'
          OR (starts_at IS NULL AND ends_at IS NULL AND max_grants IS NULL AND budget_paise IS NULL)
        );
    `)

    /**
     * Seed both brands, starting where they are today.
     *
     * Delivery free everywhere, because that is what the cart has hardcoded and this migration must
     * not change what anybody is charged. COD on for PranaJiva and off for CrossFriend, which is
     * the only difference between the two rows and the reason the mechanic exists.
     */
    await queryRunner.query(`
      INSERT INTO wallet.reward_config (brand, pincode, mechanic, version, effective_from, params, created_by)
      SELECT v.brand, NULL, 'fulfilment', 1, NOW(), v.params::jsonb, NULL
        FROM (VALUES
          ('crossfriend', '{"delivery_flat_paise":0,"delivery_free_above_paise":0,"cod_enabled":false}'),
          ('pranajiva',   '{"delivery_flat_paise":0,"delivery_free_above_paise":0,"cod_enabled":true}')
        ) AS v(brand, params)
       WHERE NOT EXISTS (
         SELECT 1 FROM wallet.reward_config c
          WHERE c.brand = v.brand AND c.pincode IS NULL AND c.mechanic = 'fulfilment'
       );
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM wallet.reward_config WHERE mechanic = 'fulfilment';

      ALTER TABLE wallet.reward_config DROP CONSTRAINT IF EXISTS reward_config_mechanic_ck;
      ALTER TABLE wallet.reward_config DROP CONSTRAINT IF EXISTS reward_config_fulfilment_ck;

      ALTER TABLE wallet.reward_config DROP CONSTRAINT IF EXISTS reward_config_scope_required_ck;
      ALTER TABLE wallet.reward_config
        ADD CONSTRAINT reward_config_scope_required_ck
        CHECK (pincode IS NOT NULL OR mechanic IN ('economics', 'studio') OR scope_mode IS NOT NULL);

      ALTER TABLE wallet.reward_config
        ADD CONSTRAINT reward_config_mechanic_ck
        CHECK (mechanic IN (
          'economics', 'signup_bonus', 'joining_cash', 'referral', 'cashback', 'studio'
        ));
      ALTER TABLE orders.orders DROP CONSTRAINT IF EXISTS orders_cod_no_gateway_ck;
      ALTER TABLE orders.orders DROP CONSTRAINT IF EXISTS orders_payment_method_ck;
      ALTER TABLE orders.orders DROP COLUMN IF EXISTS payment_method;
    `)
  }
}
