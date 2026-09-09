import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The team board — one shared thread the ops team writes into, where any message can become a task.
 *
 * ── Why this exists when the team already has WhatsApp ─────────────────────────────────────────
 * It is not trying to replace it, and it would lose if it tried: WhatsApp is on the home screen, it
 * notifies, and it is where the team already is. What it cannot do is remember. A decision made in
 * a group chat on Tuesday is unfindable by Friday, and "someone should call that baker back" scrolls
 * away the moment the next message arrives.
 *
 * So the point of this table is not the chatting — it is the second column. A message that is marked
 * as a task stops being a message that scrolls past and becomes a row with a state, sitting next to
 * the data it is about. That is the part a chat app structurally cannot give, and it is why this is
 * one table rather than two: the team should not have to decide up front whether a thought is a task.
 * They write it, and mark it later if it turns out to be one.
 *
 * ── One channel, deliberately ──────────────────────────────────────────────────────────────────
 * No rooms, no threads, no direct messages. The team is small enough that a single chronological
 * board is legible, and channels invented before anyone needs them just split a quiet room into
 * several quieter ones. When one topic genuinely needs its own space, that is a schema change worth
 * making with the evidence in hand.
 */
export class CreateTeamBoard1724500000000 implements MigrationInterface {
  name = "CreateTeamBoard1724500000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.team_messages (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        /* Kept on delete rather than cascaded away. A departed colleague's decisions are still the
           reasons things are the way they are, and deleting the account should not silently rewrite
           the record of why. The author renders as "Removed user" when the row is gone. */
        author_id   UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        body        TEXT NOT NULL,

        /* Task fields. All null on an ordinary message — a message becomes a task by being marked,
           so there is no separate table and nothing to migrate between. */
        is_task     BOOLEAN NOT NULL DEFAULT FALSE,
        is_done     BOOLEAN NOT NULL DEFAULT FALSE,
        assignee_id UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        due_on      DATE,
        done_at     TIMESTAMPTZ,
        done_by     UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,

        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        edited_at   TIMESTAMPTZ,

        /* Soft delete. Removing a message outright leaves a conversation that no longer makes sense
           — replies to something nobody can see. The row stays and the board renders a tombstone. */
        deleted_at  TIMESTAMPTZ,

        CONSTRAINT team_messages_body_not_blank CHECK (length(btrim(body)) > 0),

        /* A message cannot be done without being a task, and cannot be marked done without recording
           when. Both are cheap to enforce here and awkward to chase down later. */
        CONSTRAINT team_messages_done_implies_task CHECK (NOT is_done OR is_task),
        CONSTRAINT team_messages_done_has_time CHECK (is_done = (done_at IS NOT NULL))
      )
    `)

    // The board reads newest-last in one query; this is the index that serves it.
    await queryRunner.query(`
      CREATE INDEX team_messages_created_idx
        ON crossfriend.team_messages (created_at)
    `)

    /* Open tasks are the one filtered view worth an index of its own — it is what somebody checks
       when they want to know what is outstanding, and it is a small slice of a growing table. */
    await queryRunner.query(`
      CREATE INDEX team_messages_open_tasks_idx
        ON crossfriend.team_messages (due_on, created_at)
        WHERE is_task AND NOT is_done AND deleted_at IS NULL
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.team_messages`)
  }
}
