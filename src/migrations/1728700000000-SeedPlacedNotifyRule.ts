import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The order-confirmation rule that the original seed left out.
 *
 * ── What was missing ──────────────────────────────────────────────────────────────────────────
 * CreateOrderNotifications seeded six statuses per brand — paid, accepted, making,
 * out_for_delivery, delivered, cancelled — but not `placed`, even though the CHECK constraint
 * allows it. The omission was invisible because nothing fired `placed` either, so there was no
 * rule to miss.
 *
 * It matters now because `placed` is the only confirmation a cash order can have. A card order
 * becomes `paid` seconds after it is written and the `paid` rule covers it; a cash order has no
 * payment event until somebody collects money at the door, days later. Without a `placed` rule a
 * COD customer's first message from us would be `out_for_delivery` — the order itself would never
 * be acknowledged. That is the gap this row closes, paired with the notify call now made in
 * createOrderFromCart's cash branch.
 *
 * ── Why it ships disabled, like every other rule ──────────────────────────────────────────────
 * Because the DLT template it needs does not exist yet, and `notify_rules_enabled_ck` refuses an
 * enabled rule with no template anyway. The row's job is to appear in OPS as a status somebody has
 * thought about and is waiting on an approval for, which the original migration explains is
 * deliberately different from no row at all.
 */
export class SeedPlacedNotifyRule1728700000000 implements MigrationInterface {
  name = "SeedPlacedNotifyRule1728700000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO orders.notify_rules (brand, status, is_enabled, note)
      SELECT b.brand, 'placed', false,
             'Order confirmed. Fires for cash orders only, at the moment the storefront shows the confirmation screen — a card order is confirmed by the paid rule instead, once the money has actually moved.'
        FROM (VALUES ('crossfriend'), ('pranajiva')) AS b(brand)
      ON CONFLICT (brand, status) DO NOTHING;
    `)
  }

  /**
   * Removes only a rule still in its seeded state.
   *
   * By the time anyone runs this down, the row may be pointing at an approved DLT template that
   * took real paperwork to obtain. Deleting that on a rollback would quietly discard the mapping
   * and silence a live confirmation, so the delete is conditional and a configured rule survives.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM orders.notify_rules
       WHERE status = 'placed' AND template_id IS NULL AND NOT is_enabled;
    `)
  }
}
