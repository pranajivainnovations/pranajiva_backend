import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * CrossFriend Personal Assistant — capability one: remembering things for people.
 *
 * ── What this is, and what it deliberately is not ──────────────────────────────────────────────
 * Not a reminder feature of the cake studio. The Assistant is the product and reminders are its
 * first capability; if AI Cake Studio disappeared tomorrow this should still make complete sense.
 * The schema follows that: nothing here references a design, an order or a product, and nothing
 * about a reminder implies a purchase. It has to be useful to somebody who never buys anything.
 *
 * ── Why a delivery queue instead of a scheduled job that looks up birthdays ────────────────────
 * A failed cake order loses an order. A failed reminder loses trust in the whole assistant, and it
 * fails silently — nobody reports the notification they never received, they just quietly stop
 * believing in it. So "when should this be sent" is written down as a row *before* the moment
 * arrives, rather than recomputed by whatever happens to be running at the time.
 *
 * That single decision buys most of the reliability. The queue survives a restart, a deploy and a
 * crash mid-send. Retries are a column rather than a mechanism. "Did it actually go?" is a select
 * rather than a guess. And the unique constraint on (reminder, occurrence) makes a double-send
 * structurally impossible, which matters more than it sounds: a job that runs twice is the normal
 * consequence of a deploy, and the second run must be free.
 *
 * ── Why occurrences are materialised one at a time ─────────────────────────────────────────────
 * A yearly reminder has infinitely many occurrences. The next one is created when the reminder is
 * saved, and the one after it when the current one is sent — so the table stays proportional to the
 * number of reminders rather than to time, and a reminder edited in March correctly moves the
 * occurrence that has not happened yet.
 */
export class CreateReminders1725000000000 implements MigrationInterface {
  name = "CreateReminders1725000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.reminders (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        /* Cascaded on purpose. Deleting an account has to take the reminders and their notes with
           it — under DPDP that is an erasure obligation, and a nullable owner would leave personal
           data about third parties sitting in a row nobody can claim or delete. */
        customer_id   VARCHAR NOT NULL REFERENCES public.customer(id) ON DELETE CASCADE,

        /* Free text, whatever the person would write on a calendar: "Mum's birthday", "Anniversary",
           "Renew insurance". Deliberately not a name field plus a relationship field — see notes. */
        title         TEXT NOT NULL,

        /**
         * The optional bucket for anything that might help later: what they like, what was done last
         * year, a phone number, habits.
         *
         * Unstructured on purpose. Rigid person/relationship columns would invite structured data
         * about third parties and minors, which is precisely what DPDP restricts for profiling and
         * targeted advertising — and a schema that invites it makes it the default. Free text is also
         * what a language model reads best, so nothing is lost for the phases where the Assistant
         * starts to help rather than only remember.
         *
         * It must be treated as sensitive regardless of shape: never logged, never included in an
         * export, never sent anywhere, and gone when the reminder is. The content is what the law
         * cares about, not the column layout.
         */
        notes         TEXT,

        /* The date the thing actually happens, not the date we send. Separating them is what lets
           lead time change without rewriting what the reminder is about. */
        event_date    DATE NOT NULL,

        /* Two, and only two. Every extra recurrence pattern is a new class of edge case at the
           boundary of months and leap years, and V1 does not need to be a calendar. */
        repeat_rule   TEXT NOT NULL DEFAULT 'once',

        /* How many days before the event to send. 0 means on the day. */
        lead_days     INT  NOT NULL DEFAULT 0,

        /* Paused rather than deleted, so somebody can silence one without losing what it said. */
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,

        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT reminders_title_not_blank CHECK (length(btrim(title)) > 0),
        CONSTRAINT reminders_repeat_ck       CHECK (repeat_rule IN ('once', 'yearly')),
        /* A fortnight is already a generous warning for a birthday; beyond that the reminder arrives
           so early it is forgotten again before the day. */
        CONSTRAINT reminders_lead_ck         CHECK (lead_days BETWEEN 0 AND 30)
      )
    `)

    await queryRunner.query(`
      CREATE INDEX reminders_customer_idx
        ON crossfriend.reminders (customer_id, event_date)
        WHERE is_active
    `)

    await queryRunner.query(`
      CREATE TABLE crossfriend.reminder_deliveries (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reminder_id   UUID NOT NULL REFERENCES crossfriend.reminders(id) ON DELETE CASCADE,

        /* Which occurrence this is for — the 2027 birthday, not the 2026 one. Paired with the unique
           constraint below, this is what makes a double-send impossible rather than unlikely. */
        occurrence_date DATE NOT NULL,

        /* The instant to send, already resolved. Computed once, in India time, and stored as an
           absolute moment so nothing downstream has to know what zone anything was written in. */
        due_at        TIMESTAMPTZ NOT NULL,

        status        TEXT NOT NULL DEFAULT 'pending',
        attempts      INT  NOT NULL DEFAULT 0,

        /* When the drain may next pick this up. Backoff is a value rather than a schedule, so a
           retry policy can change without migrating anything already queued. */
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        sent_at       TIMESTAMPTZ,
        /* Kept for the delivery log the person can see: "we tried, the browser was gone" is a much
           better answer than a reminder that appears to have never existed. */
        last_error    TEXT,

        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT reminder_deliveries_status_ck
          CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
        CONSTRAINT reminder_deliveries_sent_has_time
          CHECK (status <> 'sent' OR sent_at IS NOT NULL),

        /* One delivery per occurrence, forever. A job that runs twice is the normal consequence of a
           deploy; the second run has to be free. */
        CONSTRAINT reminder_deliveries_once UNIQUE (reminder_id, occurrence_date)
      )
    `)

    /* The only hot query: what is due now. Partial, because sent and cancelled rows accumulate
       forever and there is no reason to carry them in the index the drain uses every minute. */
    await queryRunner.query(`
      CREATE INDEX reminder_deliveries_due_idx
        ON crossfriend.reminder_deliveries (next_attempt_at)
        WHERE status = 'pending'
    `)

    await queryRunner.query(`
      CREATE INDEX reminder_deliveries_reminder_idx
        ON crossfriend.reminder_deliveries (reminder_id, occurrence_date DESC)
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.reminder_deliveries`)
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.reminders`)
  }
}
