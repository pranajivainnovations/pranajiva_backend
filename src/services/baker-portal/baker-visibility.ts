import type { MedusaRequest } from "@medusajs/medusa"

import { getCrossFriendChannelId } from "./publication"

/**
 * Projects a bakery's own lifecycle onto its products' visibility.
 *
 * The gap this closes: `applyPublicationState` was the only code in the system that could change
 * whether a product is buyable, and it is reachable only from the baker's own publish button. OPS
 * could deactivate a bakery, or un-tick "visible publicly", and its cakes stayed `published`, stayed
 * in the crossfriend sales channel, and stayed on sale. Nothing joined the two facts up.
 *
 * ── What makes a product visible ────────────────────────────────────────────────────────────────
 * Three conditions, all required:
 *
 *   bakers.is_active     the account exists and is not suspended
 *   bakers.is_public     the bakery is meant to appear on the storefront at all
 *   publication_state    the baker themselves published this particular product
 *
 * `bakers.status` is deliberately NOT one of them. That column is the sales pipeline stage
 * (prospect → contacted → …); it describes how far along a conversation is, not whether an account
 * may trade. Gating on it would take a live bakery off the storefront the moment someone tidied up
 * a CRM field, which is exactly the kind of surprise this module exists to prevent.
 *
 * ── Why publication_state is never written here ─────────────────────────────────────────────────
 * Hiding is a projection, not a state change. `publication_state` records what the BAKER decided,
 * and that intent has to survive being suspended — otherwise reactivating a bakery would silently
 * leave every product hidden, and someone would have to remember which ones had been live. So this
 * only ever moves the two Medusa-side facts, and reactivation restores precisely the set that was
 * on sale before, with no bookkeeping.
 */

export interface BakerVisibilitySyncResult {
  bakerLive: boolean
  /** Products whose Medusa projection was taken down to match the bakery's state. */
  hidden: number
  /** Products put back on sale because the bakery became live again and the baker had published them. */
  restored: number
  /** Already correct — the normal case, and why this is cheap to call on every baker save. */
  unchanged: number
}

/** The one definition of "this bakery may sell right now". */
export function isBakerLive(baker: { is_active: boolean; is_public: boolean }): boolean {
  return Boolean(baker.is_active) && Boolean(baker.is_public)
}

/**
 * Recomputes every product of one bakery and writes only what actually differs.
 *
 * Idempotent by construction: it compares the desired projection against the live one and touches
 * nothing that already agrees. That matters because OPS calls this after every baker save, most of
 * which change neither flag.
 *
 * Runs in a single transaction for the same reason `applyPublicationState` does — a product left
 * `published` but out of the sales channel is invisible and unbuyable while claiming to be on sale.
 */
export async function syncBakerProductVisibility(
  req: MedusaRequest,
  bakerId: string
): Promise<BakerVisibilitySyncResult> {
  const manager = req.scope.resolve("manager")
  const productService = req.scope.resolve("productService")

  let result: BakerVisibilitySyncResult = {
    bakerLive: false,
    hidden: 0,
    restored: 0,
    unchanged: 0,
  }

  await manager.transaction(async (tm: any) => {
    const bakerRows = await tm.query(
      `SELECT is_active, is_public FROM baker_network.bakers WHERE id = $1`,
      [bakerId]
    )
    if (!bakerRows.length) {
      throw new Error("Baker not found")
    }

    const live = isBakerLive(bakerRows[0])
    const channelId = await getCrossFriendChannelId(tm)

    // FOR UPDATE on the ownership rows, so a baker publishing at the same moment as ops suspending
    // them resolves one way or the other rather than interleaving into a half-applied state.
    const products = await tm.query(
      `SELECT bp.medusa_product_id,
              bp.publication_state,
              p.status AS medusa_status,
              EXISTS (
                SELECT 1 FROM public.product_sales_channel psc
                 WHERE psc.product_id = bp.medusa_product_id
                   AND psc.sales_channel_id = $2
              ) AS in_channel
         FROM baker_network.baker_products bp
         JOIN public.product p ON p.id = bp.medusa_product_id
        WHERE bp.baker_id = $1
        FOR UPDATE OF bp`,
      [bakerId, channelId]
    )

    let hidden = 0
    let restored = 0
    let unchanged = 0

    for (const row of products) {
      // The baker's own intent, unchanged by anything here.
      const bakerWantsItLive = row.publication_state === "published"
      const shouldBeLive = live && bakerWantsItLive
      const isLive = row.medusa_status === "published" && row.in_channel

      if (shouldBeLive === isLive) {
        unchanged++
        continue
      }

      await productService.withTransaction(tm).update(row.medusa_product_id, {
        status: shouldBeLive ? "published" : "proposed",
      })

      if (shouldBeLive) {
        await tm.query(
          `INSERT INTO public.product_sales_channel (product_id, sales_channel_id)
           VALUES ($1, $2)
           ON CONFLICT (product_id, sales_channel_id) DO NOTHING`,
          [row.medusa_product_id, channelId]
        )
        restored++
      } else {
        await tm.query(
          `DELETE FROM public.product_sales_channel
            WHERE product_id = $1 AND sales_channel_id = $2`,
          [row.medusa_product_id, channelId]
        )
        hidden++
      }
    }

    result = { bakerLive: live, hidden, restored, unchanged }
  })

  return result
}
