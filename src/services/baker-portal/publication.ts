import type { MedusaRequest } from "@medusajs/medusa"

import { missingForPublish } from "./product-metadata"

/** "a name, a description and at least one photo" — a list a baker reads, not a field dump. */
function formatList(items: string[]): string {
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/**
 * Publication — the ONLY code allowed to change what a baker product's visibility looks like.
 *
 * CrossFriend's own lifecycle lives on baker_products.publication_state. Medusa knows nothing about
 * it, so that state has to be projected onto two Medusa-side facts, and both must move together:
 *
 *   publication_state   Medusa status   crossfriend sales channel
 *   ─────────────────   ─────────────   ─────────────────────────
 *   published           published       member
 *   draft               proposed        not a member
 *   unavailable         proposed        not a member
 *   archived            proposed        not a member
 *
 * Two independent gates on purpose. `status` keeps an unpublished product out of /store/products
 * (which only ever returns 'published'), and channel membership keeps it out of every cart. Either
 * alone would be enough on a good day; both together mean a bug in one does not put a half-finished
 * cake on sale.
 *
 * ── Why 'proposed' and not 'draft' ──────────────────────────────────────────────────────────────
 * AI Studio already uses Medusa 'draft' to mean "bespoke cake, must never appear in a catalogue".
 * Reusing it would make two very different states indistinguishable in the database — an OPS
 * moderation view or a cleanup script could not tell a baker's unfinished listing from a customer's
 * personalised order. 'proposed' is a valid Medusa status that nothing else in this install uses.
 *
 * ── Why membership of a channel is what makes something buyable ─────────────────────────────────
 * Medusa refuses a line item whose product is not on the cart's sales channel. That is not a
 * theory: the AI Studio route carries a comment about hitting it live on the very first
 * add-to-cart. So joining the crossfriend channel is precisely the act of going on sale, and
 * leaving it is precisely the act of coming off — which is why unpublishing does not need to touch
 * anything else to be effective immediately.
 */

export type PublicationState = "draft" | "published" | "unavailable" | "archived"

export const PUBLICATION_STATES: PublicationState[] = [
  "draft",
  "published",
  "unavailable",
  "archived",
]

/**
 * Which moves a baker may make.
 *
 * Archived is terminal: a baker can always retire a listing, but cannot resurrect one. Bringing
 * something back is an ops action, deliberately — an archived product may have been retired for a
 * reason that outlives the baker's memory of it.
 */
const ALLOWED_TRANSITIONS: Record<PublicationState, PublicationState[]> = {
  draft: ["published", "archived"],
  published: ["unavailable", "archived"],
  unavailable: ["published", "archived"],
  archived: [],
}

export function canTransition(from: PublicationState, to: PublicationState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

/** Copy for the baker when a move is refused — never "invalid state transition". */
export function transitionRefusalMessage(from: PublicationState, to: PublicationState): string {
  if (from === "archived") {
    return "This product is archived. Contact CrossFriend if you'd like it back."
  }
  if (from === to) {
    return "That's already the case."
  }
  return "That change isn't possible from here."
}

let cachedChannelId: string | null = null

/**
 * The crossfriend sales channel, resolved by NAME rather than a hardcoded id.
 *
 * Ids differ between environments; the name is the stable fact. Cached for the process lifetime
 * because a sales channel is created once and never renamed in practice — and at ~54ms per round
 * trip to this database, looking it up on every publish would be a needless tax.
 */
export async function getCrossFriendChannelId(manager: any): Promise<string> {
  if (cachedChannelId) return cachedChannelId

  const rows = await manager.query(
    `SELECT id FROM public.sales_channel WHERE lower(name) = 'crossfriend' AND deleted_at IS NULL LIMIT 1`
  )
  if (!rows.length) {
    throw new Error("The 'crossfriend' sales channel is missing from this environment.")
  }

  cachedChannelId = rows[0].id
  return cachedChannelId as string
}

export interface ApplyResult {
  productId: string
  state: PublicationState
  medusaStatus: "published" | "proposed"
  inChannel: boolean
}

/**
 * Moves one product to a new publication state, projecting it onto Medusa.
 *
 * Everything happens in a single transaction against Medusa's own EntityManager: the ownership
 * row, the Medusa status, and channel membership either all move or none do. A product that was
 * 'published' in our table but absent from the channel would be invisible and unbuyable while
 * claiming to be on sale — the exact inconsistency that is impossible to debug from a bug report.
 *
 * Ownership is verified INSIDE the transaction with a row lock rather than trusted from an earlier
 * read, so two publishes racing each other cannot interleave.
 */
export async function applyPublicationState(
  req: MedusaRequest,
  bakerId: string,
  productId: string,
  next: PublicationState
): Promise<ApplyResult> {
  const manager = req.scope.resolve("manager")
  const productService = req.scope.resolve("productService")

  let result: ApplyResult | null = null

  await manager.transaction(async (tm: any) => {
    const owned = await tm.query(
      `SELECT publication_state
         FROM baker_network.baker_products
        WHERE baker_id = $1 AND medusa_product_id = $2
        FOR UPDATE`,
      [bakerId, productId]
    )

    if (!owned.length) {
      // 404 rather than 403 upstream — a baker should not be able to discover that a product id
      // exists by being told they may not touch it.
      throw new Error("NOT_FOUND")
    }

    const current = owned[0].publication_state as PublicationState
    if (!canTransition(current, next)) {
      throw new Error(`REFUSED:${transitionRefusalMessage(current, next)}`)
    }

    const goingLive = next === "published"

    // The completeness gate, checked at publish rather than at creation. A baker is meant to be
    // able to save a half-finished listing and come back to it — that is what the draft state is
    // for. What must not happen is an incomplete listing reaching a customer.
    //
    // Read inside the transaction and after FOR UPDATE, so it reflects the product as it is right
    // now rather than as it was when the page was rendered.
    if (goingLive) {
      const rows = await tm.query(
        `SELECT p.title, p.description, p.thumbnail, p.metadata, p.type_id,
                (SELECT COUNT(*)::INT FROM public.product_variant v WHERE v.product_id = p.id) AS variant_count
           FROM public.product p WHERE p.id = $1`,
        [productId]
      )
      const p = rows[0]
      const missing = missingForPublish({
        title: p?.title,
        description: p?.description,
        thumbnail: p?.thumbnail,
        metadata: p?.metadata,
        variantCount: p?.variant_count ?? 0,
      })

      // Products created before the type field existed have no type. Publishing one would put it
      // on the channel while leaving it invisible to every occasion page and type filter — live
      // but unfindable, which is worse than blocked.
      if (!p?.type_id) {
        missing.push("what kind of product this is")
      }

      if (missing.length) {
        throw new Error(
          `REFUSED:Before this can go live it needs ${formatList(missing)}.`
        )
      }
    }
    const channelId = await getCrossFriendChannelId(tm)

    await productService.withTransaction(tm).update(productId, {
      status: goingLive ? "published" : "proposed",
    })

    if (goingLive) {
      // product_sales_channel is a pure junction: two columns, composite primary key, no id of its
      // own. ON CONFLICT DO NOTHING makes republishing something already in the channel a no-op
      // rather than a duplicate-key error the baker reads as "something went wrong".
      await tm.query(
        `INSERT INTO public.product_sales_channel (product_id, sales_channel_id)
         VALUES ($1, $2)
         ON CONFLICT (product_id, sales_channel_id) DO NOTHING`,
        [productId, channelId]
      )
    } else {
      await tm.query(
        `DELETE FROM public.product_sales_channel
          WHERE product_id = $1 AND sales_channel_id = $2`,
        [productId, channelId]
      )
    }

    // `goingLive` is passed as its own boolean parameter rather than comparing $1 to a literal
    // inside the CASE. Reusing one placeholder as both a column value and a comparison operand
    // leaves Postgres unable to settle on a single type for it — the same "inconsistent types
    // deduced for parameter" failure the catalogue migration hit.
    //
    // COALESCE keeps the FIRST publish date: unpublishing and republishing should not make a
    // listing look newly created, since published_at is what "recently added" will sort on.
    await tm.query(
      `UPDATE baker_network.baker_products
          SET publication_state = $1,
              published_at = CASE WHEN $2 THEN COALESCE(published_at, NOW()) ELSE published_at END,
              updated_at = NOW()
        WHERE baker_id = $3 AND medusa_product_id = $4`,
      [next, goingLive, bakerId, productId]
    )

    result = {
      productId,
      state: next,
      medusaStatus: goingLive ? "published" : "proposed",
      inChannel: goingLive,
    }
  })

  return result!
}
