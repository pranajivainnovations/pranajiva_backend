import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Tick state for the manual steps of a rollout — the ones no query can verify.
 *
 * Written for the MSG91 / DLT launch, where the blocking work happens on a TRAI portal over days or
 * weeks and the context is easy to lose between sessions. Most of that checklist cannot be derived:
 * "the header was submitted", "the template was approved", "the auth key is set on the server" are
 * facts about the world, not about this database.
 *
 * ── Only the state lives here, not the checklist ───────────────────────────────────────────────
 * The task catalogue — labels, grouping, order, help text — is defined in OPS code, the same split
 * the site_settings migration uses and for the same reason: adding or rewording a step should be a
 * one-line edit, not a migration. A row here is meaningless without its catalogue entry, and a
 * catalogue entry with no row simply reads as "not done yet".
 *
 * Deliberately generic rather than named for this launch. The next rollout that needs a shared
 * checklist gets a new group of task keys in OPS code and no schema change at all.
 */
export class CreateRolloutTaskState1724300000000 implements MigrationInterface {
  name = "CreateRolloutTaskState1724300000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.rollout_task_state (
        task_key    VARCHAR(96) PRIMARY KEY,
        is_done     BOOLEAN NOT NULL DEFAULT FALSE,
        note        TEXT NOT NULL DEFAULT '',
        updated_by  UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    /**
     * No seed rows. A task is created on first tick, so the table only ever contains steps somebody
     * actually touched — which means removing a step from the OPS catalogue leaves a harmless
     * orphan row rather than requiring a cleanup migration.
     */
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.rollout_task_state;`)
  }
}
