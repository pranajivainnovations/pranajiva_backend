import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Where OPS records what it decided about the Pranajiva research corpus.
 *
 * The corpus itself lives in Google Drive and is written by the Cowork pipelines — 432 content
 * topics, 76 classical formulas, 18 product concepts, spread across four pipelines. OPS reads all
 * of it and stores none of it. What OPS *does* own is the decision layer on top: which topic to
 * research next, which formula is worth turning into a product, which concept is dead.
 *
 * ── Why a table rather than writing back into Drive ─────────────────────────────────────────────
 * Two reasons, one principled and one practical.
 *
 * The principled one is the same rule the catalogue taxonomy follows: reference the external thing,
 * never duplicate or overwrite it. Drive is the pipelines' output. If OPS edited it, the next
 * pipeline run and the OPS team would be two writers on one document with no merge story, and the
 * losing edit would vanish silently.
 *
 * The practical one is that it does not work. The Drive connector cannot edit the body of an
 * existing Google Doc — it creates files and changes metadata, nothing else. That is exactly why
 * MASTER_PROJECT_INDEX currently claims `01_FORMULA_RESEARCH — Status: empty` when the folder holds
 * seven files: the correction had to be written as a separate document, and the index was never
 * patched. A decision layer that lived in Drive would inherit that failure.
 *
 * The service account is deliberately scoped `drive.readonly`, so this is enforced, not just
 * intended.
 *
 * ── Why one table and not one per subject ──────────────────────────────────────────────────────
 * A decision about a topic, a formula, a product concept and a whole document are the same shape:
 * something was looked at, a person concluded something, and left a note. Splitting that into four
 * near-identical tables would mean four queries, four actions and four migrations the first time a
 * fifth kind of subject appears. `subject_kind` is free text for the same reason: a new pipeline
 * bringing a new kind of item must not require a migration.
 *
 * `status` is likewise unconstrained at the database level. The vocabulary belongs to OPS, where
 * adding "blocked" is a one-line change; the OPS action writes only statuses it knows about, so a
 * typo cannot invent one. Same argument as crossfriend.site_settings' key/value shape.
 *
 * `subject_key` is a natural key from the corpus (`AH-SU-0042`, a Drive file id, a topic id) rather
 * than a foreign key, because the thing it points at is not in this database and never will be. A
 * decision therefore survives a document being re-uploaded under a new Drive file id, as long as
 * the item's own identifier is stable — which is what the pipelines' own numbering conventions are
 * for.
 */
export class CreatePranajivaResearchSchema1724100000000 implements MigrationInterface {
  name = "CreatePranajivaResearchSchema1724100000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS pranajiva;`)

    await queryRunner.query(`
      CREATE TABLE pranajiva.decisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_kind VARCHAR(32) NOT NULL,
        subject_key VARCHAR(200) NOT NULL,
        status VARCHAR(32),
        note TEXT NOT NULL DEFAULT '',
        decided_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (subject_kind, subject_key)
      );
    `)

    /**
     * The overview screen asks "how many topics are shortlisted" far more often than it asks about
     * any single topic, and the pipeline boards filter by status within a kind. Both are this index.
     */
    await queryRunner.query(`
      CREATE INDEX idx_pranajiva_decisions_kind_status
        ON pranajiva.decisions (subject_kind, status);
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pranajiva.decisions;`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS pranajiva;`)
  }
}
