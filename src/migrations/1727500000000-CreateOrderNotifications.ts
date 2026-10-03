import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Telling the customer what happened to their order.
 *
 * ── Why this is two tables and not a column ────────────────────────────────────────────────────
 * `notify_rules` is configuration — which DLT template to send for which status — and it lives in
 * the database rather than in code because the templates it names do not exist yet. Every
 * transactional SMS in India has to be registered on a DLT platform and approved, which takes
 * weeks, and the ids come back one at a time. Putting the mapping in a table means each approval is
 * an edit in OPS rather than a deploy, and the system does nothing at all until the first one
 * arrives rather than failing on the way there.
 *
 * `notifications` is the log, and it is what makes sending safe to retry. An order can reach
 * `delivered` twice if somebody corrects a mistake, two ops users can press at the same moment, and
 * the sweep job moves orders on its own schedule — so "has this customer already been told this"
 * has to be a fact in the database, not a hope. The unique index is the guarantee.
 *
 * ── Why the log is append-only ─────────────────────────────────────────────────────────────────
 * Same rule as orders.order_events and the wallet ledger. A row here is evidence that a message was
 * sent to a person's phone; an UPDATE could rewrite that into never having happened, and the first
 * time a customer says "you never told me" the record has to be worth something.
 */
export class CreateOrderNotifications1727500000000 implements MigrationInterface {
  name = "CreateOrderNotifications1727500000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /**
       * Which template answers which status.
       *
       * Keyed by brand as well as status: CrossFriend and PranaJiva send under different sender
       * headers from different DLT registrations, so the same status is a different template for
       * each. A row that exists with a NULL template is a status somebody has thought about and has
       * no approval for yet, which is deliberately different from no row at all.
       */
      CREATE TABLE IF NOT EXISTS orders.notify_rules (
        brand        VARCHAR(32)  NOT NULL,
        status       VARCHAR(32)  NOT NULL,
        template_id  UUID         REFERENCES crossfriend.sms_templates(id) ON DELETE SET NULL,
        is_enabled   BOOLEAN      NOT NULL DEFAULT false,
        note         TEXT,
        updated_by   VARCHAR(64),
        updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        PRIMARY KEY (brand, status),

        CONSTRAINT notify_rules_brand_ck  CHECK (brand IN ('crossfriend', 'pranajiva')),
        CONSTRAINT notify_rules_status_ck CHECK (status IN (
          'placed', 'accepted', 'making', 'out_for_delivery', 'delivered', 'cancelled', 'paid'
        )),
        /**
         * Enabled requires a template. Without this a rule could be switched on with nothing to
         * send, which fails silently at the moment a customer was expecting to hear from us — the
         * exact failure mode that let GA ship missing twice.
         */
        CONSTRAINT notify_rules_enabled_ck CHECK (NOT is_enabled OR template_id IS NOT NULL)
      );

      /**
       * What was actually sent.
       *
       * A sent_ok of false with an error is kept rather than discarded: a provider rejection is
       * the thing somebody needs to see, and a log of successes alone cannot explain a silence.
       */
      CREATE TABLE IF NOT EXISTS orders.notifications (
        id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id            UUID         NOT NULL REFERENCES orders.orders(id) ON DELETE CASCADE,
        status              VARCHAR(32)  NOT NULL,
        mobile              VARCHAR(20)  NOT NULL,
        template_id         UUID         REFERENCES crossfriend.sms_templates(id) ON DELETE SET NULL,
        sent_ok             BOOLEAN      NOT NULL,
        provider_message_id VARCHAR(128),
        error               TEXT,
        sent_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      /**
       * One message per status per order — the whole point of the table.
       *
       * Partial on sent_ok: a failed attempt must not block a later retry, but a successful send
       * must never be repeated. So a customer can be told once, and a provider outage does not
       * permanently consume the only chance to tell them.
       */
      CREATE UNIQUE INDEX IF NOT EXISTS notifications_once_per_status
        ON orders.notifications (order_id, status) WHERE sent_ok;

      CREATE INDEX IF NOT EXISTS notifications_order_idx
        ON orders.notifications (order_id, sent_at DESC);

      CREATE TRIGGER notifications_append_only
        BEFORE UPDATE OR DELETE ON orders.notifications
        FOR EACH ROW EXECUTE FUNCTION orders.refuse_mutation();
    `)

    /**
     * Seed the rules disabled, with no template.
     *
     * So the OPS screen shows every status that CAN be announced the moment it ships, each waiting
     * on a DLT id, rather than an empty table that makes the feature look unbuilt. Nothing sends:
     * is_enabled is false and there is no template to send.
     */
    await queryRunner.query(`
      INSERT INTO orders.notify_rules (brand, status, is_enabled, note)
      SELECT b.brand, s.status, false, s.note
        FROM (VALUES ('crossfriend'), ('pranajiva')) AS b(brand)
        CROSS JOIN (VALUES
          ('paid',             'Payment confirmed — the first thing a customer wants to hear.'),
          ('accepted',         'A baker has taken the order on.'),
          ('making',           'Being made.'),
          ('out_for_delivery', 'On its way — the one with the most impact on a support call.'),
          ('delivered',        'Delivered.'),
          ('cancelled',        'Cancelled, and why.')
        ) AS s(status, note)
      ON CONFLICT (brand, status) DO NOTHING;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS orders.notifications;`)
    await queryRunner.query(`DROP TABLE IF EXISTS orders.notify_rules;`)
  }
}
