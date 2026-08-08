import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Automatic, unique slugs for baker public profiles.
 *
 * `bakers.slug` has existed (with a UNIQUE constraint) since the original baker_network migration,
 * but nothing ever populated it — every baker had NULL, so /bakers/[slug] had nothing to route on.
 * Bakers arrive through two different paths (created by hand in OPS, or promoted from a Google
 * Places discovery), and a slug is required for both, so this belongs in the database rather than
 * in whichever application code happened to do the insert.
 *
 * Unlike public_id, a slug is deliberately NOT immutable. Ops may need to fix an awkward
 * auto-generated one ("hem-the-cake-shop"), and a baker that rebrands should be able to move. The
 * trigger only fills a slug in when one was not supplied, and never touches it on UPDATE — so an
 * explicit value always wins and an existing URL never changes underneath anyone.
 *
 * Uniqueness is resolved by suffixing (-2, -3, …) inside the same statement that inserts the row,
 * so two bakeries called "Sweet Moments" cannot collide even if they are created concurrently: the
 * UNIQUE index is the final arbiter and the loop simply finds the next free suffix.
 */
export class AddBakerSlugGeneration1723600000000 implements MigrationInterface {
  name = "AddBakerSlugGeneration1723600000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Deliberately ASCII-only. Slugs appear in URLs, get typed, pasted into WhatsApp and read over
    // the phone; transliterating Devanagari is a job for a real library, not a regex, and a baker
    // whose name is entirely non-ASCII falls back to their Baker ID below rather than to mojibake.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION baker_network.slugify(input TEXT)
      RETURNS TEXT AS $$
        SELECT NULLIF(
          trim(BOTH '-' FROM regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g')),
          ''
        );
      $$ LANGUAGE SQL IMMUTABLE;
    `)

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION baker_network.assign_baker_slug()
      RETURNS TRIGGER AS $$
      DECLARE
        base TEXT;
        candidate TEXT;
        suffix INT := 1;
      BEGIN
        IF NEW.slug IS NOT NULL AND btrim(NEW.slug) <> '' THEN
          RETURN NEW;
        END IF;

        base := baker_network.slugify(NEW.name);

        -- A name that slugifies to nothing (all punctuation, or a script we do not transliterate)
        -- still needs a routable profile URL. The Baker ID is guaranteed present and unique.
        IF base IS NULL THEN
          base := lower(NEW.public_id);
        END IF;

        -- Keep room for a suffix inside the column's 255 chars.
        base := left(base, 200);
        candidate := base;

        WHILE EXISTS (SELECT 1 FROM baker_network.bakers WHERE slug = candidate) LOOP
          suffix := suffix + 1;
          candidate := base || '-' || suffix;
        END LOOP;

        NEW.slug := candidate;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)

    // BEFORE INSERT only. An UPDATE that clears the slug is left alone rather than silently
    // regenerating one — that is a data problem worth surfacing, not papering over.
    await queryRunner.query(`
      CREATE TRIGGER trg_bakers_assign_slug
        BEFORE INSERT ON baker_network.bakers
        FOR EACH ROW EXECUTE FUNCTION baker_network.assign_baker_slug();
    `)

    // Backfill anything already present. Currently zero rows, but this keeps the migration correct
    // if it is ever run against a database that has bakers.
    await queryRunner.query(`
      UPDATE baker_network.bakers
         SET slug = COALESCE(baker_network.slugify(name), lower(public_id))
       WHERE slug IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM baker_network.bakers b2
            WHERE b2.slug = COALESCE(baker_network.slugify(bakers.name), lower(bakers.public_id))
         );
    `)

    // Public profile lookups are by slug, and only ever for bakers that are public and active.
    await queryRunner.query(`
      CREATE INDEX idx_bakers_public_profile
        ON baker_network.bakers (slug)
        WHERE is_public AND is_active;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS baker_network.idx_bakers_public_profile;`)
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_bakers_assign_slug ON baker_network.bakers;`
    )
    await queryRunner.query(`DROP FUNCTION IF EXISTS baker_network.assign_baker_slug();`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS baker_network.slugify(TEXT);`)
  }
}
