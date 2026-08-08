import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getCrossFriendChannelId } from "../../../../services/baker-portal/publication"

/**
 * GET /store/crossfriend/sales-channel
 *
 * The sales channel the CrossFriend storefront trades on.
 *
 * The storefront needs this to create carts on the right channel — Medusa rejects a line item whose
 * product is not on the cart's channel, and the store's DEFAULT channel is Pranajiva's, so a cart
 * left to default cannot hold a CrossFriend product.
 *
 * Served rather than configured through an environment variable on purpose. An env var is one
 * typo away from silently putting every cart on the wrong channel, and the symptom — "add to cart
 * does nothing" — points nowhere near the cause. Resolving it from the backend by name means the
 * storefront cannot drift out of step with the database.
 *
 * Not sensitive: a sales channel id already appears in product payloads Medusa serves publicly.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const id = await getCrossFriendChannelId(req.scope.resolve("manager"))
    return res.status(200).json({ salesChannelId: id })
  } catch (error) {
    console.error("[API /store/crossfriend/sales-channel] Error:", error)
    // The storefront falls back to Medusa's default channel if this fails, which is exactly the
    // behaviour it had before — degraded, not broken.
    return res.status(200).json({ salesChannelId: null })
  }
}
