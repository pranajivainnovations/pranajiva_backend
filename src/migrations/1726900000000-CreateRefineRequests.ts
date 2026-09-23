import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * "We'll refine it for you" — the queue behind the fallback.
 *
 * ── What this is actually for ──────────────────────────────────────────────────────────────────
 * It looks like a support inbox and it is not. Somebody who has described a cake ten different ways
 * and still not got what they pictured is not a support ticket — they are a customer with a clear
 * intent to buy and a tool that has failed to express it. The same is true of somebody who has run
 * out of generations: the allowance refuses them and tells them to talk to us, and this is where
 * that conversation arrives.
 *
 * So the volume in this table is the most honest signal the Studio produces. Generation counts say
 * people tried; this says what they wanted and could not get.
 *
 * ── Why this one is NOT append-only, unlike the grants beside it ───────────────────────────────
 * A grant is a fact about money and must never change. This is a piece of work, and work moves —
 * open, then handled. Freezing it would mean a second table just to record that somebody replied.
 *
 * What is kept immutable is the part that would otherwise be rewritten to look better: the customer's
 * own message and when they sent it. The columns that move are the ops side, and they are guarded so
 * that "handled" can never mean nobody in particular handled it at some unrecorded time.
 */
export class CreateRefineRequests1726900000000 implements MigrationInterface {
  name = "CreateRefineRequests1726900000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ai_studio.refine_requests (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        /* Not a foreign key, matching the rest of this schema: ai_studio deliberately does not
           constrain against Medusa's core customer table. */
        customer_id   character varying NOT NULL,

        /* What they were looking at when they asked. Both optional — somebody can ask for help
           before generating anything — but when present they turn a vague request into a specific
           one, because ops can see the design the customer means. */
        generation_id uuid,
        design_id     uuid,

        /* In their words. The whole value of this table. */
        message       text NOT NULL,

        /* How to reach them, when it differs from the account. OTP customers have a synthetic email
           that cannot receive mail, so a number typed here is often the only way to reply. */
        contact       character varying,

        status        character varying NOT NULL DEFAULT 'open',

        created_at    timestamptz NOT NULL DEFAULT now(),
        handled_by    uuid REFERENCES baker_network.ops_users(id),
        handled_at    timestamptz,
        handled_note  text,

        CONSTRAINT refine_requests_status_ck
          CHECK (status IN ('open', 'handled', 'closed')),

        CONSTRAINT refine_requests_message_ck
          CHECK (length(btrim(message)) >= 3),

        /**
         * Handled means somebody handled it.
         *
         * Without this, a status column drifts: rows get marked done by a background job, a bulk
         * update, or a hand in a database client, and six weeks later nobody can say who spoke to
         * the customer or whether anybody did. The constraint makes "handled" unsayable without an
         * author and a time.
         */
        CONSTRAINT refine_requests_handled_ck
          CHECK (
            status = 'open'
            OR (handled_by IS NOT NULL AND handled_at IS NOT NULL)
          )
      );
    `)

    /* The queue reads open rows oldest-first — somebody waiting longest is served first — and the
       duplicate guard reads one customer's open rows. */
    await queryRunner.query(`
      CREATE INDEX refine_requests_open_idx
        ON ai_studio.refine_requests (created_at)
        WHERE status = 'open';
      CREATE INDEX refine_requests_customer_idx
        ON ai_studio.refine_requests (customer_id, status);
    `)

    /**
     * One open request per customer.
     *
     * Enforced here rather than only in the service, because the thing it protects against is a
     * double-tapped button and a slow network — two requests racing, which a check-then-insert in
     * application code loses. A customer with something more to say adds it to the conversation;
     * they do not need a second row in the queue, and ops does not need to work out which of two
     * identical rows they already answered.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX refine_requests_one_open_per_customer
        ON ai_studio.refine_requests (customer_id)
        WHERE status = 'open';
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.refine_requests;`)
  }
}
