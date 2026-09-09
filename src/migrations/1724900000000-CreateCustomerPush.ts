import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Browser push for the people who visit the shop, and a record of what was sent to them.
 *
 * ── Why this is not the team_push_subscriptions table with a nullable user_id ──────────────────
 * The two audiences differ in every way that matters to the schema. A team subscription belongs to a
 * known account that can be joined, revoked with the person, and counted on one hand. These belong
 * to anonymous browsers at unknown scale, may never be attached to a customer at all, and carry a
 * consent record because sending marketing to them is regulated where the team table is not.
 * Merging them would mean a nullable foreign key doing double duty as "which kind of subscriber is
 * this", and every query in both features would have to remember which case it was in.
 *
 * ── Why consent is a stored timestamp and not just the browser's permission ────────────────────
 * Under the DPDP Act consent has to be demonstrable — when it was given, and for what. The browser
 * knows only that a permission was granted at some point, tells us nothing about when, and forgets
 * entirely if site data is cleared. `consented_at` is the record; `consent_context` says which
 * screen asked, because "they agreed to order updates" and "they agreed to marketing" are different
 * permissions and a single boolean would lose the distinction the moment it mattered.
 *
 * ── Why campaigns are a table and not a log line ───────────────────────────────────────────────
 * A push cannot be recalled. Once it has gone to thirty thousand devices there is no edit and no
 * delete, so the useful questions afterwards are all historical: what exactly did it say, who
 * pressed send, how many got it, how many endpoints died. Keeping that as rows means the composer
 * can also show what went out last time, which is the cheapest guard against sending it twice.
 */
export class CreateCustomerPush1724900000000 implements MigrationInterface {
  name = "CreateCustomerPush1724900000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.push_subscribers (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        /* The push service's URL for this browser. Unique because re-subscribing returns the same
           endpoint, and without this one person who allows twice receives everything twice. */
        endpoint       TEXT NOT NULL UNIQUE,
        p256dh         TEXT NOT NULL,
        auth           TEXT NOT NULL,

        /* Set when we happen to know who this is, and left null the rest of the time. Deliberately
           not a foreign key: this table is written by a public endpoint, and a constraint against
           the Medusa customer table would let a caller probe which ids exist by watching which
           writes fail. The value is only ever used to skip somebody, never to join. */
        customer_id    TEXT,

        /* Demonstrable consent — see the note above. */
        consented_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        consent_context TEXT NOT NULL DEFAULT 'unknown',

        user_agent     TEXT NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sent_at   TIMESTAMPTZ,

        /* A push service answers 404 or 410 when a subscription is dead. Recorded rather than
           deleted, so a transient outage cannot silently empty the list, and so the count of people
           who left is visible rather than inferred from a number that quietly shrank. */
        failed_at      TIMESTAMPTZ,
        failure_count  INT NOT NULL DEFAULT 0,

        /* Someone turning notifications off in our own UI, as opposed to the browser going away.
           Separate from failed_at because they mean different things and only one of them is a
           decision — a revoked subscriber must never be resurrected by a later re-subscribe. */
        revoked_at     TIMESTAMPTZ
      )
    `)

    /* The only query that runs at scale: every live subscriber, for a send. Partial, because a dead
       or revoked row is never selected and there is no reason to carry it in the index. */
    await queryRunner.query(`
      CREATE INDEX push_subscribers_live_idx
        ON crossfriend.push_subscribers (created_at)
        WHERE failed_at IS NULL AND revoked_at IS NULL
    `)

    await queryRunner.query(`
      CREATE TABLE crossfriend.push_campaigns (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        title         TEXT NOT NULL,
        body          TEXT NOT NULL,
        /* Where a click lands. Relative paths are allowed and are the common case. */
        url           TEXT NOT NULL DEFAULT '/',
        image_url     TEXT,

        /* draft → sending → sent, or failed. 'sending' exists so a crash mid-send is visible as a
           campaign stuck in flight rather than one that looks like it never started. */
        status        TEXT NOT NULL DEFAULT 'draft',

        sent_at       TIMESTAMPTZ,
        sent_count    INT NOT NULL DEFAULT 0,
        failed_count  INT NOT NULL DEFAULT 0,

        created_by    UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT push_campaigns_status_ck
          CHECK (status IN ('draft', 'sending', 'sent', 'failed')),

        /* A sent campaign has to say when. Cheap here, and impossible to reconstruct later. */
        CONSTRAINT push_campaigns_sent_has_time
          CHECK (status <> 'sent' OR sent_at IS NOT NULL),

        CONSTRAINT push_campaigns_title_not_blank CHECK (length(btrim(title)) > 0),
        CONSTRAINT push_campaigns_body_not_blank  CHECK (length(btrim(body)) > 0)
      )
    `)

    await queryRunner.query(`
      CREATE INDEX push_campaigns_recent_idx
        ON crossfriend.push_campaigns (created_at DESC)
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.push_campaigns`)
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.push_subscribers`)
  }
}
