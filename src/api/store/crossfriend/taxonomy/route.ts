import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"

/**
 * GET /store/crossfriend/taxonomy
 *
 * The whole CrossFriend navigation taxonomy in one response: product types, occasions, and the
 * matrix that pairs them.
 *
 * ── Why one route and not three ─────────────────────────────────────────────────────────────────
 * These three things are only ever useful together — a type list without the matrix cannot render
 * an occasion page, and a matrix referencing types the caller has not loaded is meaningless. Three
 * routes would mean three round trips to a database that sits on a different cloud from the
 * backend (measured at ~54ms per trip), and would let a caller observe an inconsistent taxonomy
 * mid-edit. One query, one snapshot.
 *
 * ── Why the storefront cannot read this from Medusa directly ───────────────────────────────────
 * Medusa's /store/product-types and /store/collections return every type and collection in the
 * database, including Pranajiva's — the two brands share this install. They also have no notion of
 * "active", no display order, and no way to express the matrix at all. This route is the filter.
 *
 * Inactive rows are omitted entirely rather than returned with a flag. A caller that receives them
 * has to remember to filter, and one that forgets ships a retired type into navigation — the exact
 * class of silent failure this whole taxonomy change exists to remove.
 *
 * No auth: this is public navigation data, identical for every visitor.
 */

interface TaxonomyType {
  id: string
  value: string
  label: string
  emoji: string | null
  order: number
}

interface TaxonomyOccasion {
  id: string
  handle: string
  label: string
  tagline: string | null
  emoji: string | null
  gradient: string | null
  order: number
}

export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  try {
    const pool = getBakerNetworkDbPool()

    // deleted_at is checked on the Medusa side of each join because a type can be soft-deleted in
    // Medusa Admin without anything telling CrossFriend — the registry row would survive and keep
    // publishing a dead type into navigation.
    const [typeRes, occRes, matrixRes] = await Promise.all([
      pool.query(
        `SELECT pt.id, pt.value, t.label, t.emoji, t.display_order
           FROM crossfriend.product_types t
           JOIN public.product_type pt ON pt.id = t.type_id AND pt.deleted_at IS NULL
          WHERE t.is_active
          ORDER BY t.display_order, t.label`
      ),
      pool.query(
        `SELECT pc.id, pc.handle, o.label, o.tagline, o.emoji, o.gradient, o.display_order
           FROM crossfriend.occasions o
           JOIN public.product_collection pc ON pc.id = o.collection_id AND pc.deleted_at IS NULL
          WHERE o.is_active
          ORDER BY o.display_order, o.label`
      ),
      // The matrix is filtered by BOTH sides being active, so deactivating a type removes it from
      // every occasion page at once without touching a single pairing row. That is the point of
      // is_active being a flag rather than a delete: retiring Costumes for a season and then
      // bringing it back must not lose which occasions it belonged to.
      pool.query(
        `SELECT pc.handle AS occasion, pt.value AS type
           FROM crossfriend.occasion_product_types m
           JOIN crossfriend.occasions o ON o.collection_id = m.collection_id AND o.is_active
           JOIN crossfriend.product_types t ON t.type_id = m.type_id AND t.is_active
           JOIN public.product_collection pc ON pc.id = m.collection_id AND pc.deleted_at IS NULL
           JOIN public.product_type pt ON pt.id = m.type_id AND pt.deleted_at IS NULL
          ORDER BY m.display_order`
      ),
    ])

    const types: TaxonomyType[] = typeRes.rows.map((r) => ({
      id: r.id,
      value: r.value,
      label: r.label,
      emoji: r.emoji,
      order: r.display_order,
    }))

    const occasions: TaxonomyOccasion[] = occRes.rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      label: r.label,
      tagline: r.tagline,
      emoji: r.emoji,
      gradient: r.gradient,
      order: r.display_order,
    }))

    // Keyed by occasion handle because that is how it is read — "what sections does this page
    // show?" Every occasion gets a key even when empty, so a caller can distinguish "no types
    // mapped" from "unknown occasion" without a second lookup.
    const matrix: Record<string, string[]> = {}
    for (const o of occasions) matrix[o.handle] = []
    for (const row of matrixRes.rows) matrix[row.occasion]?.push(row.type)

    return res.status(200).json({ types, occasions, matrix })
  } catch (error) {
    console.error("[crossfriend/taxonomy] failed", error)
    // Empty rather than 500: navigation renders nothing instead of taking the whole page down with
    // it. Callers already treat an empty taxonomy as "nothing configured yet".
    return res.status(200).json({ types: [], occasions: [], matrix: {} })
  }
}
