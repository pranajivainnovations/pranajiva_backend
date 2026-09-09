import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Browser push subscriptions and per-person read state for the team board.
 *
 * ── Why push and not email ─────────────────────────────────────────────────────────────────────
 * Nothing in this system can send an email — there is no SMTP, no provider, no credentials. The only
 * outbound channel wired up is MSG91, and every SMS template it sends has to clear DLT registration
 * with TRAI first, which is measured in weeks and is a heavy way to tell a colleague they have been
 * assigned something.
 *
 * Web push needs none of that. No vendor, no per-message cost, no regulator, and the browser handles
 * delivery. The trade is that it only reaches a browser the person has granted permission in, so it
 * is deliberately paired with an in-app unread count that works everywhere.
 *
 * ── Why a row per subscription, not per user ───────────────────────────────────────────────────
 * One person is a laptop and a phone and possibly a second browser, and each is a separate endpoint
 * with its own keys. Storing one subscription per user would silently mean "only the last device you
 * granted permission on", which is exactly the sort of quiet half-working that makes people stop
 * trusting notifications.
 */
export class CreateTeamPush1724600000000 implements MigrationInterface {
  name = "CreateTeamPush1724600000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.team_push_subscriptions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES baker_network.ops_users(id) ON DELETE CASCADE,

        /* The push service's URL for this device. Unique because re-subscribing the same browser
           returns the same endpoint, and without this a person who clicks Enable twice would get
           every notification twice. */
        endpoint    TEXT NOT NULL UNIQUE,
        p256dh      TEXT NOT NULL,
        auth        TEXT NOT NULL,

        /* Only so a person can tell their own devices apart when revoking one. */
        user_agent  TEXT NOT NULL DEFAULT '',

        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sent_at TIMESTAMPTZ,

        /* A push service returns 404 or 410 when a subscription is dead — the browser was
           uninstalled, permission revoked, the profile wiped. Recorded rather than deleted on the
           first failure, because a transient outage should not silently unsubscribe the team. */
        failed_at   TIMESTAMPTZ,
        failure_count INT NOT NULL DEFAULT 0
      )
    `)

    await queryRunner.query(`
      CREATE INDEX team_push_user_idx
        ON crossfriend.team_push_subscriptions (user_id)
        WHERE failed_at IS NULL
    `)

    /**
     * When each person last looked at the board.
     *
     * Its own table rather than a column on ops_users: this is board state, and a notification
     * feature should not be adding columns to the account record. One row per person, written on
     * every visit, which is the cheapest possible write.
     */
    await queryRunner.query(`
      CREATE TABLE crossfriend.team_board_reads (
        user_id      UUID PRIMARY KEY REFERENCES baker_network.ops_users(id) ON DELETE CASCADE,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.team_board_reads`)
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.team_push_subscriptions`)
  }
}
