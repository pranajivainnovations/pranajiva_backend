import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Telling US about a new order, through the machinery that already tells the customer.
 *
 * ── Why this is a notify_rule and not a new table ─────────────────────────────────────────────
 * Everything an internal alert needs already exists here and works: a per-brand rule pointing at a
 * DLT-approved template, a send path that cannot break an order, an append-only log, a unique index
 * that makes "send once" a fact rather than a hope, an OPS screen that lists the rules, and a test
 * panel that sends one to a number of your choosing. A separate alerts table would have been a
 * second copy of all of it, and the first time the two disagreed somebody would be chasing a
 * message that the other half believed it had sent.
 *
 * So an internal alert is modelled as what it actually is: the same kind of rule, pointed at a
 * different phone. `recipient_mobile` is the only new idea — NULL means "the customer", which is
 * every existing row, and a number means "this person instead".
 *
 * ── Why `ops_new_order` sits in the status column ─────────────────────────────────────────────
 * It is not an order status and never appears in orders.orders — the CHECK there still refuses it.
 * It is the *occasion* for a message, which is what this column has always meant: `paid` is not an
 * order status either, as the original migration's comment says. Keeping both in one column is what
 * lets the log, the dedupe index and the OPS screen cover internal alerts without knowing they
 * exist.
 *
 * ── Why the number is in the database ─────────────────────────────────────────────────────────
 * An on-call number changes, and it changes on the day somebody is unreachable — which is the worst
 * possible moment to need a deploy. It is a setting, not a credential: it cannot spend money and
 * publishing it would embarrass rather than compromise, so it belongs next to the rule that uses it
 * where OPS can edit it. The MSG91 key stays in the environment for exactly the opposite reason.
 */
export class OpsNewOrderAlert1728800000000 implements MigrationInterface {
  name = "OpsNewOrderAlert1728800000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE orders.notify_rules
        ADD COLUMN IF NOT EXISTS recipient_mobile VARCHAR(20);
    `)

    await queryRunner.query(`
      ALTER TABLE orders.notify_rules
        DROP CONSTRAINT IF EXISTS notify_rules_status_ck;
    `)

    await queryRunner.query(`
      ALTER TABLE orders.notify_rules
        ADD CONSTRAINT notify_rules_status_ck CHECK (status IN (
          'placed', 'accepted', 'making', 'out_for_delivery', 'delivered', 'cancelled', 'paid',
          'ops_new_order'
        ));
    `)

    /**
     * An internal alert with no number to send to would be a rule that silently does nothing, which
     * is the failure this table's other constraint exists to prevent. Enforced here rather than in
     * OPS because OPS is one writer and psql is another.
     */
    await queryRunner.query(`
      ALTER TABLE orders.notify_rules
        ADD CONSTRAINT notify_rules_internal_needs_mobile_ck
          CHECK (status <> 'ops_new_order' OR recipient_mobile IS NOT NULL);
    `)

    /**
     * Ten bare digits, so the send path never has to guess whether a +91 is already on the front.
     * The same shape `tenDigits` in the notify service produces, checked here so a hand-typed row
     * cannot be the thing that breaks a send.
     */
    await queryRunner.query(`
      ALTER TABLE orders.notify_rules
        ADD CONSTRAINT notify_rules_recipient_shape_ck
          CHECK (recipient_mobile IS NULL OR recipient_mobile ~ '^[6-9][0-9]{9}$');
    `)

    /**
     * PranaJiva's on-call number, as given. Disabled, because the DLT template it needs does not
     * exist yet and `notify_rules_enabled_ck` refuses an enabled rule with nothing to send.
     *
     * CrossFriend gets no row: its orders go to a baker's portal, which is already how that brand
     * learns about work, and seeding a second channel nobody asked for would mean one more rule on
     * the screen that must be explained as deliberately off.
     */
    await queryRunner.query(`
      INSERT INTO orders.notify_rules (brand, status, recipient_mobile, is_enabled, note)
      VALUES (
        'pranajiva', 'ops_new_order', '9811730868', false,
        'Internal alert. Goes to the on-call number above, not to the customer, the moment an order becomes real — at checkout for cash, at payment for card.'
      )
      ON CONFLICT (brand, status) DO NOTHING;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM orders.notify_rules
       WHERE status = 'ops_new_order' AND template_id IS NULL AND NOT is_enabled;
    `)
    await queryRunner.query(`
      ALTER TABLE orders.notify_rules
        DROP CONSTRAINT IF EXISTS notify_rules_recipient_shape_ck,
        DROP CONSTRAINT IF EXISTS notify_rules_internal_needs_mobile_ck;
    `)
    /* Left in place: an ops_new_order row somebody configured would violate a narrowed CHECK, and a
       rollback must not fail on data the forward migration invited. */
  }
}
