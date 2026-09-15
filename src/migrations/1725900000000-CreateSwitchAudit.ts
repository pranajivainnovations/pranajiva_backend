import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The global stop, and a trail of who flipped what — GS-3.5.
 *
 * ── Why the global switch is not a config version ──────────────────────────────────────────────
 * Every other switch in this system is a new row in `wallet.reward_config`: scoped, versioned,
 * validated, merged with its brand default. That machinery is right for running an offer and wrong
 * for stopping everything at two in the morning. A global stop has to work when the configuration
 * is the problem — a bad version, a merge that resolves to something nobody expected, a validator
 * refusing the very row somebody is trying to write. So it lives in `wallet.settings`, is read in
 * one query with no merge and no version resolution, and is checked before any of that machinery is
 * consulted.
 *
 * It is one switch for everything, deliberately. Per-brand and per-mechanic stops already exist; the
 * thing missing was a control that needs no thought about scope, and adding a scope to it would put
 * a decision in front of somebody who needs a button.
 *
 * ── Why the log is separate from the settings row ──────────────────────────────────────────────
 * The row holds the current value because that is what gets read on every order. The log holds what
 * happened, because "who turned the rewards off on Saturday, and did anyone turn them back on"
 * cannot be answered by a column that only remembers its latest value. Append-only, for the reason
 * every other table here is: a trail somebody can edit is not a trail.
 *
 * Flips of the per-mechanic and per-pincode switches need no entry here — those ARE config versions,
 * already append-only and already carrying a note and an author.
 */
export class CreateSwitchAudit1725900000000 implements MigrationInterface {
  name = "CreateSwitchAudit1725900000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallet.settings_log (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key         VARCHAR(64) NOT NULL,

        /* Both sides, so the trail reads without having to reconstruct it from the row before. */
        old_value   TEXT,
        new_value   TEXT NOT NULL,

        /**
         * Why. Required, and required for a reason: the value alone says rewards stopped on
         * Saturday and says nothing about whether that was fraud, a budget scare or a test somebody
         * forgot to undo — which is the entire question a week later.
         */
        reason      TEXT NOT NULL,

        changed_by  UUID REFERENCES baker_network.ops_users(id) ON DELETE RESTRICT,
        changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT settings_log_reason_ck CHECK (length(btrim(reason)) > 0)
      );

      CREATE INDEX settings_log_key_time ON wallet.settings_log (key, changed_at DESC);
    `)

    await queryRunner.query(`
      CREATE TRIGGER settings_log_append_only
        BEFORE UPDATE OR DELETE ON wallet.settings_log
        FOR EACH ROW EXECUTE FUNCTION wallet.refuse_mutation();
    `)

    /**
     * Seeded on, which is the only safe default for a switch whose absence must never mean "stopped".
     *
     * A missing row is read as ON by the code that reads it, for the same reason: a database blip
     * that silently halted every reward would be an outage nobody could diagnose from the customer
     * side, where the only symptom is that nothing happens. The switch stops rewards when somebody
     * says so, not when something goes wrong.
     */
    await queryRunner.query(`
      INSERT INTO wallet.settings (key, value)
      VALUES ('rewards_globally_enabled', 'true')
      ON CONFLICT (key) DO NOTHING;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS wallet.settings_log;`)
    await queryRunner.query(
      `DELETE FROM wallet.settings WHERE key = 'rewards_globally_enabled';`
    )
  }
}
