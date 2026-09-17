import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Where an offer runs — chosen, rather than assumed.
 *
 * ── What was wrong with the old model ──────────────────────────────────────────────────────────
 * Switching a mechanic on at brand level switched it on in every onboarded pincode at once, and the
 * only way to keep one out was to remember it existed and write a row turning it off. That is an
 * opt-out, and opt-out is the wrong default for something that gives money away: the failure mode is
 * an offer quietly running somewhere nobody meant it to, and nothing about the screen would say so.
 *
 * The readiness bar hid this. An unready pincode does not serve, so "everywhere" looked safe while
 * there was only one ready pincode — it would have stopped looking safe on the day the second one
 * went live, which is the worst possible day to discover it.
 *
 * ── The two modes, and why both exist ──────────────────────────────────────────────────────────
 * 'selected' names the pincodes. 'all' means every pincode, and is kept because it is genuinely what
 * a mature brand-wide offer wants and because the readiness bar still gates it — but it now has to be
 * asked for by name instead of being what you get by saying nothing.
 *
 * ── Why a pincode override still beats the list ────────────────────────────────────────────────
 * A pincode-level row exists only because somebody created it, and creating one is the act of saying
 * what happens there. It continues to win outright, so a pincode can be piloted without touching the
 * list, and can be stopped without editing it either. The list is the default for pincodes that have
 * said nothing about themselves.
 *
 * ── Why existing rows become 'all' ─────────────────────────────────────────────────────────────
 * Because that is what they currently mean, and a migration that changes what live configuration does
 * is a migration that switches an offer off without anybody asking for it. They are migrated to say
 * out loud what they already did; narrowing them is an operator's decision, in OPS, with an audit
 * trail behind it.
 */
export class AddPincodeScopeToRewardConfig1726200000000 implements MigrationInterface {
  name = "AddPincodeScopeToRewardConfig1726200000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config
        ADD COLUMN scope_mode     text,
        ADD COLUMN scope_pincodes text[];
    `)

    /**
     * Say out loud what the existing brand-level rows already do.
     *
     * The table is append-only and its trigger refuses UPDATE, which is correct for every caller:
     * configuration is versioned so that the reason a rate changed is always recoverable, and an
     * in-place edit destroys that. A migration adding a column is the one exception, because it is
     * not changing a decision — it is filling in a field that did not exist when the row was written
     * with the answer the row already implied. The trigger is put back before this statement's
     * transaction ends, so no other session ever sees it off.
     */
    await queryRunner.query(`ALTER TABLE wallet.reward_config DISABLE TRIGGER reward_config_append_only`)

    await queryRunner.query(`
      UPDATE wallet.reward_config
         SET scope_mode = 'all'
       WHERE pincode IS NULL
         AND mechanic <> 'economics';
    `)

    await queryRunner.query(`ALTER TABLE wallet.reward_config ENABLE TRIGGER reward_config_append_only`)

    await queryRunner.query(`
      ALTER TABLE wallet.reward_config
        /* Two modes and nothing else. */
        ADD CONSTRAINT reward_config_scope_mode_ck
          CHECK (scope_mode IS NULL OR scope_mode IN ('all', 'selected')),

        /* A scope belongs to the brand-level row. A pincode row IS its own scope — carrying a list
           of other pincodes there would be a second, contradictory answer to the same question. */
        ADD CONSTRAINT reward_config_scope_level_ck
          CHECK (pincode IS NULL OR (scope_mode IS NULL AND scope_pincodes IS NULL)),

        /* Economics is not an offer and does not run anywhere; it is the brand's numbers, and they
           apply wherever anything is measured. */
        ADD CONSTRAINT reward_config_scope_economics_ck
          CHECK (mechanic <> 'economics' OR (scope_mode IS NULL AND scope_pincodes IS NULL)),

        /* Every serving mechanic's brand row must say where it runs. This is the constraint that
           makes "all" a decision rather than a default. */
        ADD CONSTRAINT reward_config_scope_required_ck
          CHECK (
            pincode IS NOT NULL
            OR mechanic = 'economics'
            OR scope_mode IS NOT NULL
          ),

        /* 'selected' with no list would be a mechanic that is on and runs nowhere, which is a state
           worth refusing rather than debugging. An empty array is still permitted and means exactly
           that on purpose — it is how an operator parks an offer without losing its settings. */
        ADD CONSTRAINT reward_config_scope_list_ck
          CHECK (scope_mode <> 'selected' OR scope_pincodes IS NOT NULL),

        /* A list may only contain things that are pincodes.
           Expressed by joining the array and matching the whole string, because a CHECK constraint
           may not contain a subquery — so the obvious NOT EXISTS over unnest() is rejected outright
           by Postgres rather than merely being slower. */
        ADD CONSTRAINT reward_config_scope_shape_ck
          CHECK (
            scope_pincodes IS NULL
            OR cardinality(scope_pincodes) = 0
            OR array_to_string(scope_pincodes, ',') ~ '^[1-9][0-9]{5}(,[1-9][0-9]{5})*$'
          );
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallet.reward_config
        DROP CONSTRAINT IF EXISTS reward_config_scope_mode_ck,
        DROP CONSTRAINT IF EXISTS reward_config_scope_level_ck,
        DROP CONSTRAINT IF EXISTS reward_config_scope_economics_ck,
        DROP CONSTRAINT IF EXISTS reward_config_scope_required_ck,
        DROP CONSTRAINT IF EXISTS reward_config_scope_list_ck,
        DROP CONSTRAINT IF EXISTS reward_config_scope_shape_ck,
        DROP COLUMN IF EXISTS scope_mode,
        DROP COLUMN IF EXISTS scope_pincodes;
    `)
  }
}
