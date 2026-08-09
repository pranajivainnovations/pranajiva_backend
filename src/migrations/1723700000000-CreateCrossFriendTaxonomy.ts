import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * CrossFriend taxonomy — the Occasion × Product Type matrix, and the registries it joins.
 *
 * ── What this replaces ──────────────────────────────────────────────────────────────────────────
 * The same relationship was previously expressed in FOUR places that had drifted apart:
 *
 *   1. TYPE_OCCASION_MAP        (storefront code)   — membership, hardcoded
 *   2. type-occasion-map.json   (storefront disk)   — overrides 1, silently ignores unknown keys
 *   3. OCCASIONS[].sectionOrder (storefront code)   — section ordering, disagreed with 1
 *   4. OCCASION_KITS            (storefront code)   — a second, hand-synced copy for quick-add kits
 *
 * They disagreed. `birthday.sectionOrder` listed `costume`, which TYPE_OCCASION_MAP excludes from
 * birthday. The JSON's `"Fancy-Dress"` key had never taken effect at all, because the loader
 * whitelists keys against a frozen PRODUCT_TYPES array that spells it `costume` — an edit that
 * looked applied and did nothing. None of these could fail loudly: a missing key in a JSON object
 * is just `undefined`.
 *
 * A row with a foreign key cannot drift. That is the whole point of this migration.
 *
 * ── Why a CrossFriend schema and not Medusa metadata ────────────────────────────────────────────
 * Medusa v1 has no representation for a relationship between a product_type and a
 * product_collection — verified: no table in `public` carries both a type_id and a collection_id
 * except `product` itself, where they only ever meet on one product row. The matrix is a rule about
 * two taxonomies, not a fact about any product, so it cannot live on products without denormalising
 * it onto every row.
 *
 * It also cannot live in `metadata` JSONB: there is no integrity, no FK, and no way to fail loudly —
 * which is exactly how the four sources above drifted.
 *
 * `is_active` likewise has nowhere to live in Medusa: product_type and product_collection have only
 * id/value/handle/timestamps/metadata. Retiring "Costumes" for a season needs a real column.
 *
 * ── Why the matrix FKs to OUR tables, not Medusa's ──────────────────────────────────────────────
 * occasion_product_types references crossfriend.product_types / crossfriend.occasions rather than
 * public.product_type / public.product_collection directly. That makes registration a precondition:
 * a Medusa product type cannot appear in the matrix until it has been deliberately adopted as a
 * CrossFriend type. This replaces the frozen PRODUCT_TYPES array in storefront code with a
 * constraint the database enforces — and, unlike that array, adding one no longer needs a deploy.
 *
 * It also keeps Pranajiva's product types (Herbal Powder, SuperFood, …) structurally unable to
 * appear in CrossFriend navigation. They share this database; nothing else keeps them out.
 *
 * ── Registry reconciliation ─────────────────────────────────────────────────────────────────────
 * The model was never broken — the registries were never populated to match the config, so every
 * type chip filtered on a value no product could have. Of six configured types only `cake` existed;
 * of five configured occasions only `birthday` and `anniversary` existed. This migration reconciles
 * them, which is what actually makes occasion pages work for the first time.
 *
 * Renames (decorations→decor, fancy-dress→costume, festivals→festival) are safe because all three
 * hold zero products — verified before writing this. They are guarded by NOT EXISTS anyway, since
 * neither product_type.value nor product_collection.handle carries a unique constraint, so a blind
 * UPDATE could silently create a duplicate.
 *
 * ── Every query here filters `deleted_at IS NULL` ───────────────────────────────────────────────
 * This database carries soft-deleted collections from an abandoned earlier iteration: dead rows
 * still holding the handles `birthday`, `anniversary`, `festival`, `kids` and `special`. Medusa
 * soft-deletes, so those rows are invisible to the store API but very much present in the table.
 *
 * Without the filter, adoption matches a handle twice (once live, once dead) and registers the
 * corpse alongside the real collection, while the NOT EXISTS guards see a dead row and skip work
 * that genuinely needed doing. Both happened on the first run of this migration.
 *
 * The dead rows are deliberately left in place rather than purged: nothing references them
 * (verified — zero products, zero discount conditions), Medusa already tolerates duplicate handles
 * across live/deleted rows, and deleting historical rows is not a schema migration's business.
 */
export class CreateCrossFriendTaxonomy1723700000000 implements MigrationInterface {
  name = "CreateCrossFriendTaxonomy1723700000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Schema ────────────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS crossfriend`)

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS crossfriend.product_types (
        type_id       VARCHAR(255) PRIMARY KEY
                      REFERENCES public.product_type(id) ON DELETE CASCADE,
        label         VARCHAR(120) NOT NULL,
        emoji         VARCHAR(16),
        display_order INT NOT NULL DEFAULT 0,
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by    UUID REFERENCES baker_network.ops_users(id)
      )
    `)

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS crossfriend.occasions (
        collection_id VARCHAR(255) PRIMARY KEY
                      REFERENCES public.product_collection(id) ON DELETE CASCADE,
        label         VARCHAR(120) NOT NULL,
        tagline       VARCHAR(240),
        emoji         VARCHAR(16),
        gradient      VARCHAR(120),
        display_order INT NOT NULL DEFAULT 0,
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by    UUID REFERENCES baker_network.ops_users(id)
      )
    `)

    // The matrix. Composite PK is the whole row — a pairing either exists or it does not, and it
    // cannot exist twice. Deleting a type or an occasion cascades its pairings away, so the matrix
    // can never reference something that is gone.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS crossfriend.occasion_product_types (
        collection_id VARCHAR(255) NOT NULL
                      REFERENCES crossfriend.occasions(collection_id) ON DELETE CASCADE,
        type_id       VARCHAR(255) NOT NULL
                      REFERENCES crossfriend.product_types(type_id) ON DELETE CASCADE,
        display_order INT NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by    UUID REFERENCES baker_network.ops_users(id),
        PRIMARY KEY (collection_id, type_id)
      )
    `)

    // Reading the matrix always starts from an occasion ("what sections does this page show?").
    // The PK already covers that lead column; this index serves the reverse question OPS asks
    // ("which occasions is this type on?") without a sequential scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cf_occasion_types_type
        ON crossfriend.occasion_product_types (type_id)
    `)

    // ── Registry reconciliation: product types ────────────────────────────────────────────────
    // Rename first, so the inserts below don't create a second row for a type that already exists
    // under its old name.
    const typeRenames: Array<[string, string]> = [
      ["decorations", "decor"],
      ["fancy-dress", "costume"],
    ]
    for (const [from, to] of typeRenames) {
      await queryRunner.query(
        `UPDATE public.product_type SET value = $2, updated_at = NOW()
          WHERE value = $1 AND deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM public.product_type WHERE value = $2 AND deleted_at IS NULL
            )`,
        [from, to]
      )
    }

    // Deterministic ids for rows we create, matching the pcat_cf_* convention already used by the
    // catalogue taxonomy: idempotent re-runs, and legible in the OPS Database Explorer. Medusa
    // treats this column as an opaque varchar.
    const newTypes: Array<[string, string]> = [
      ["ptyp_cf_gift", "gift"],
      ["ptyp_cf_toys", "toys"],
      ["ptyp_cf_wellness", "wellness"],
    ]
    for (const [id, value] of newTypes) {
      await queryRunner.query(
        // Params in a SELECT list carry no type context, so Postgres infers `text` there while the
        // same param is `varchar` in the WHERE — "inconsistent types deduced". Cast explicitly.
        `INSERT INTO public.product_type (id, value, created_at, updated_at)
         SELECT $1::varchar, $2::varchar, NOW(), NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM public.product_type WHERE value = $2 AND deleted_at IS NULL
          )`,
        [id, value]
      )
    }

    // ── Registry reconciliation: occasion collections ─────────────────────────────────────────
    await queryRunner.query(`
      UPDATE public.product_collection SET handle = 'festival', updated_at = NOW()
       WHERE handle = 'festivals' AND deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.product_collection
            WHERE handle = 'festival' AND deleted_at IS NULL
         )
    `)

    const newCollections: Array<[string, string, string]> = [
      ["pcol_cf_kids", "Kids Events", "kids"],
      ["pcol_cf_special", "Special Moments", "special"],
    ]
    for (const [id, title, handle] of newCollections) {
      await queryRunner.query(
        `INSERT INTO public.product_collection (id, title, handle, created_at, updated_at, metadata)
         SELECT $1::varchar, $2::varchar, $3::varchar, NOW(), NOW(), '{"brand":"crossfriend"}'::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM public.product_collection WHERE handle = $3 AND deleted_at IS NULL
          )`,
        [id, title, handle]
      )
    }

    // ── Adopt registries into CrossFriend ─────────────────────────────────────────────────────
    // Presentation lives here rather than in Medusa metadata so that label, emoji, ordering and
    // is_active are one row that OPS owns — the previous split (order in JSON, emoji in metadata,
    // membership in code) is precisely what allowed them to disagree.
    const cfTypes: Array<[string, string, string, number]> = [
      // value, label, emoji, display_order
      ["cake", "Cakes", "🎂", 1],
      ["decor", "Decorations", "🎊", 2],
      ["gift", "Gifts", "🎁", 3],
      ["costume", "Costumes", "🎭", 4],
      ["toys", "Toys", "🧸", 5],
      ["wellness", "Premium / Wellness", "🌿", 6],
    ]
    for (const [value, label, emoji, order] of cfTypes) {
      await queryRunner.query(
        `INSERT INTO crossfriend.product_types (type_id, label, emoji, display_order)
         SELECT id, $2, $3, $4 FROM public.product_type
          WHERE value = $1 AND deleted_at IS NULL
         ON CONFLICT (type_id) DO NOTHING`,
        [value, label, emoji, order]
      )
    }

    const cfOccasions: Array<[string, string, string, string, string, number]> = [
      // handle, label, tagline, emoji, gradient, display_order
      ["birthday", "Birthday", "Make their day unforgettable", "🎂", "from-cf-orange to-cf-coral", 1],
      ["anniversary", "Anniversary", "Celebrate your love story", "💝", "from-cf-pink to-cf-purple", 2],
      ["festival", "Festivals", "Spread the festive joy", "🪔", "from-cf-yellow to-cf-orange", 3],
      ["kids", "Kids Events", "Fun for the little ones", "🎈", "from-cf-purple to-cf-pink", 4],
      ["special", "Special Moments", "Because every moment matters", "✨", "from-cf-coral to-cf-purple", 5],
    ]
    for (const [handle, label, tagline, emoji, gradient, order] of cfOccasions) {
      await queryRunner.query(
        `INSERT INTO crossfriend.occasions (collection_id, label, tagline, emoji, gradient, display_order)
         SELECT id, $2, $3, $4, $5, $6 FROM public.product_collection
          WHERE handle = $1 AND deleted_at IS NULL
         ON CONFLICT (collection_id) DO NOTHING`,
        [handle, label, tagline, emoji, gradient, order]
      )
    }

    // ── Seed the matrix ───────────────────────────────────────────────────────────────────────
    // MEMBERSHIP is taken from TYPE_OCCASION_MAP (after the JSON overlay is applied) — the rule
    // that actually ran in production. ORDER is taken from OCCASIONS[].sectionOrder, the storefront's
    // display intent. Where sectionOrder named a type that TYPE_OCCASION_MAP excludes from that
    // occasion (birthday→costume), membership wins: the pairing is not created. That is the one
    // place the four old sources contradicted each other, and it is resolved here in favour of the
    // rule that governed what customers actually saw.
    const matrix: Record<string, string[]> = {
      birthday: ["cake", "decor", "gift"],
      anniversary: ["cake", "gift", "wellness", "decor"],
      festival: ["gift", "wellness", "decor", "cake", "costume"],
      kids: ["costume", "cake", "decor", "toys"],
      special: ["gift", "cake", "decor", "wellness", "toys", "costume"],
    }
    for (const [handle, types] of Object.entries(matrix)) {
      for (let i = 0; i < types.length; i++) {
        await queryRunner.query(
          `INSERT INTO crossfriend.occasion_product_types (collection_id, type_id, display_order)
           SELECT o.collection_id, t.type_id, $3
             FROM crossfriend.occasions o
             JOIN public.product_collection pc ON pc.id = o.collection_id
             CROSS JOIN crossfriend.product_types t
             JOIN public.product_type pt ON pt.id = t.type_id
            WHERE pc.handle = $1 AND pc.deleted_at IS NULL
              AND pt.value = $2 AND pt.deleted_at IS NULL
           ON CONFLICT (collection_id, type_id) DO NOTHING`,
          [handle, types[i], i + 1]
        )
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops CrossFriend's own tables only. The Medusa product_type / product_collection rows this
    // migration created or renamed are deliberately left alone: products may have been filed
    // against them by now, and deleting a type would orphan or delete real catalogue data to undo
    // a taxonomy change. Reversing those is a data decision, not a schema rollback.
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.occasion_product_types`)
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.occasions`)
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.product_types`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS crossfriend RESTRICT`)
  }
}
