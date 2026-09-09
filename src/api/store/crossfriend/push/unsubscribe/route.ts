import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../../services/baker-network/db"

/**
 * POST /store/crossfriend/push/unsubscribe
 *
 * Turns notifications off for one browser.
 *
 * ── Why marking rather than deleting ───────────────────────────────────────────────────────────
 * A deleted row and a row that was never there are the same thing, and they should not be. Keeping
 * the record means the suppression is demonstrable — somebody who says they opted out has a
 * timestamp proving it, which is exactly what a consent regime asks for. It also keeps the audience
 * numbers honest: a list that shrinks tells you nothing about whether people are leaving.
 *
 * ── Why anybody may unsubscribe any endpoint they can name ─────────────────────────────────────
 * There is no authentication here, so in principle a caller who knew somebody else's endpoint could
 * switch off their notifications. That is acceptable, and deliberately so: the endpoint is a long
 * unguessable URL held by the browser and our database, the worst outcome is that a person stops
 * receiving marketing they can re-enable in a click, and the alternative — making people prove who
 * they are before they can be left alone — is a far worse trade. Opting out must always be the
 * easiest path in the system.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const payload = (req.body ?? {}) as Record<string, unknown>
  const endpoint = typeof payload.endpoint === "string" ? payload.endpoint.trim() : ""

  if (!endpoint || endpoint.length > 1000) {
    res.status(400).json({ ok: false })
    return
  }

  try {
    await getBakerNetworkDbPool().query(
      `UPDATE crossfriend.push_subscribers
          SET revoked_at = NOW()
        WHERE endpoint = $1
          AND revoked_at IS NULL`,
      [endpoint]
    )
  } catch (error) {
    console.error("[push] could not revoke subscription", error)
    res.status(500).json({ ok: false })
    return
  }

  /* Always ok, whether a row matched or not. The browser has already unsubscribed locally by the
     time this is called, so the person is off either way — and reporting "no such subscription"
     would let an unauthenticated caller test which endpoints we hold. */
  res.json({ ok: true })
}
