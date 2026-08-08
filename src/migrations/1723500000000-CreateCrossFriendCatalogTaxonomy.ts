import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The Ready-to-Order category tree — CrossFriend's marketplace taxonomy.
 *
 * Authored as a migration rather than a seed script because the marketplace cannot function without
 * it: every baker product is filed under one of these, and the storefront filters on them. Making
 * it a migration means it exists identically in every environment, arrives automatically with a
 * deploy, and is tracked and ordered like any other schema change.
 *
 * ── Why Medusa product categories, and not product.type or metadata ──────────────────────────────
 * Categories are a first-class, indexed, server-side filterable relation: `category_id[]` on
 * /store/products. `metadata` cannot be filtered by the store API at all (which is exactly why the
 * old storefront had to fetch the entire catalogue and filter `metadata.brand` in JavaScript), and
 * `product.type` is a single flat value with no hierarchy. At the hundreds-of-thousands-of-products
 * scale this is being built for, the filter has to run in Postgres against an index.
 *
 * ── IDs ─────────────────────────────────────────────────────────────────────────────────────────
 * Deterministic readable ids (`pcat_cf_cakes`) rather than generated ULIDs. Medusa treats this
 * column as an opaque varchar, and fixed ids make the migration genuinely idempotent, make `mpath`
 * (which embeds the id) constructible in plain SQL, and make the tree legible in the OPS Database
 * Explorer. Nothing in Medusa parses category ids.
 *
 * `mpath` is Medusa's materialised path: a root is `<id>.` and a child is `<parent_mpath><id>.`
 * It is what the category tree queries traverse, so it has to be written correctly by hand here.
 *
 * ── Deliberately NOT done here: publishable API keys ─────────────────────────────────────────────
 * The plan originally called for linking a publishable key to the crossfriend sales channel. On
 * inspection neither storefront sends a publishable key today, and both existing keys have zero
 * channel links — meaning they are currently unscoped and return everything. Attaching a key to a
 * channel is precisely what *scopes* it, so doing that now would silently narrow what the Pranajiva
 * storefront can see if it ever starts sending one. The CrossFriend storefront will pass
 * `sales_channel_id[]` explicitly instead, which is verified to filter server-side.
 */
export class CreateCrossFriendCatalogTaxonomy1723500000000 implements MigrationInterface {
  name = "CreateCrossFriendCatalogTaxonomy1723500000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    const ROOT = "pcat_cf_ready_to_order"

    // mpath is built in JS rather than concatenated in SQL: reusing one placeholder both as a
    // varchar column value and inside a text concatenation leaves Postgres unable to deduce a
    // single type for it ("inconsistent types deduced for parameter $1").
    const rootMpath = `${ROOT}.`

    // Root. is_internal stays false — this is a customer-facing browse node, not a hidden grouping.
    await queryRunner.query(
      `INSERT INTO public.product_category
         (id, name, handle, parent_category_id, mpath, is_active, is_internal, rank, description, metadata)
       VALUES
         ($1, 'Ready to Order', 'ready-to-order', NULL, $2, true, false, 0, '',
          '{"brand":"crossfriend"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ROOT, rootMpath]
    )

    // Children. `rank` drives display order in both the storefront and Medusa admin, so it encodes
    // the order these should be offered in rather than alphabetical accident.
    const children: [string, string, string][] = [
      ["pcat_cf_cakes", "Cakes", "cakes"],
      ["pcat_cf_pastries", "Pastries", "pastries"],
      ["pcat_cf_desserts", "Desserts", "desserts"],
      ["pcat_cf_brownies", "Brownies", "brownies"],
      ["pcat_cf_gifts", "Gifts", "gifts"],
      ["pcat_cf_decor", "Decor", "decor"],
    ]

    for (let i = 0; i < children.length; i++) {
      const [id, name, handle] = children[i]
      await queryRunner.query(
        `INSERT INTO public.product_category
           (id, name, handle, parent_category_id, mpath, is_active, is_internal, rank, description, metadata)
         VALUES
           ($1, $2, $3, $4, $5, true, false, $6, '',
            '{"brand":"crossfriend"}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [id, name, handle, ROOT, `${rootMpath}${id}.`, i]
      )
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Children first — parent_category_id has no cascade on this table.
    await queryRunner.query(
      `DELETE FROM public.product_category WHERE parent_category_id = 'pcat_cf_ready_to_order'`
    )
    await queryRunner.query(
      `DELETE FROM public.product_category WHERE id = 'pcat_cf_ready_to_order'`
    )
  }
}
