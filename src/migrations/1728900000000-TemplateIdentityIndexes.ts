import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Letting a template exist before its DLT id has been written down, and making the MSG91 id as
 * hard to duplicate as the DLT one.
 *
 * ── What was wrong ────────────────────────────────────────────────────────────────────────────
 * `sms_templates` was built when DLT came first and MSG91 second, which was the real order in
 * August — the registration arrived, then somebody created the matching flow. So `dlt_template_id`
 * is NOT NULL and uniquely indexed, and `provider_template_id` defaults to '' with no index at all.
 *
 * That has since inverted. Six PranaJiva order templates now exist on MSG91 with their ids in hand,
 * and the DLT ids sit in a portal somebody has to go and read. Under the old index they could not be
 * recorded at all: the first one to be entered with a blank DLT id would take '' and every one
 * after it would collide with it. A column that cannot hold "not written down yet" forces the
 * operator to either invent a value or keep six ids in a text file, and both of those lose.
 *
 * ── What changes ──────────────────────────────────────────────────────────────────────────────
 * The uniqueness becomes conditional on there being something to be unique about. A real DLT id is
 * still refused as a duplicate — that was the point of the index and it is kept — while any number
 * of templates may be waiting for theirs.
 *
 * And `provider_template_id` gets the same treatment, which it should have had all along. It is the
 * id that actually sends: two rows naming the same MSG91 template is the identical copy-paste
 * mistake the DLT index was added to catch, and it was unguarded on the more dangerous of the two.
 *
 * ── Why nothing breaks ────────────────────────────────────────────────────────────────────────
 * The column stays NOT NULL, so no reader has to learn about NULL. A partial unique index is a
 * strict weakening for existing data — both current templates carry real, distinct DLT ids and
 * satisfy the new index exactly as they satisfied the old one. Nothing reads `dlt_template_id` at
 * send time: `getFlowConfig` returns it for display, `flowBlockedReason` tests the provider id, and
 * notify.ts tests the provider id. A blank DLT id therefore cannot stop or alter a send.
 */
export class TemplateIdentityIndexes1728900000000 implements MigrationInterface {
  name = "TemplateIdentityIndexes1728900000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* So an INSERT that omits it behaves like the provider column rather than failing. */
    await queryRunner.query(`
      ALTER TABLE crossfriend.sms_templates
        ALTER COLUMN dlt_template_id SET DEFAULT '';
    `)

    await queryRunner.query(`
      DROP INDEX IF EXISTS crossfriend.sms_templates_dlt_template_id_key;
    `)

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS sms_templates_dlt_template_id_key
        ON crossfriend.sms_templates (dlt_template_id)
        WHERE dlt_template_id <> '';
    `)

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS sms_templates_provider_template_id_key
        ON crossfriend.sms_templates (provider_template_id)
        WHERE provider_template_id <> '';
    `)
  }

  /**
   * Reversing this can fail, and should.
   *
   * The old index cannot be restored while two templates are waiting for their DLT ids — they both
   * hold '' and a total unique index refuses the second. Rather than delete a row or invent an id
   * to make a rollback succeed, this lets Postgres refuse: the data the forward migration made
   * possible is real, and a down migration is not entitled to discard it silently.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS crossfriend.sms_templates_provider_template_id_key;
    `)
    await queryRunner.query(`
      DROP INDEX IF EXISTS crossfriend.sms_templates_dlt_template_id_key;
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX sms_templates_dlt_template_id_key
        ON crossfriend.sms_templates (dlt_template_id);
    `)
    await queryRunner.query(`
      ALTER TABLE crossfriend.sms_templates
        ALTER COLUMN dlt_template_id DROP DEFAULT;
    `)
  }
}
