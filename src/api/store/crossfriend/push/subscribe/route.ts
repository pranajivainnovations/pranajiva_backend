import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../../services/baker-network/db"

/**
 * POST /store/crossfriend/push/subscribe
 *
 * Records a browser that has agreed to receive notifications.
 *
 * ── This is an unauthenticated write, so what stops it being abused ────────────────────────────
 * It has to be public: the whole point is a visitor who has not signed in. Three things keep that
 * safe rather than one.
 *
 * The endpoint is unique and the insert upserts, so calling this a thousand times with the same
 * body produces one row — the cost of a flood is bounded by how many distinct push endpoints the
 * caller can obtain, and those come from Google, Apple and Mozilla, not from us.
 *
 * Everything is length-capped before it reaches the database, so a caller cannot post a megabyte of
 * text into a column and make the table expensive to read.
 *
 * And a row here is inert. It is not an account, it grants nothing, and the only thing it can ever
 * do is receive a notification we choose to send. A fake subscription's worst outcome is one wasted
 * request during a campaign, and it is retired the first time the push service says it is gone.
 *
 * ── Why the response says nothing about what happened ──────────────────────────────────────────
 * Always `{ ok: true }`, including when the row already existed. "Already subscribed" would tell an
 * unauthenticated caller whether a given endpoint is known to us, and there is no reason for anyone
 * outside to be able to ask that question.
 */

/** Generous enough for every real push service, small enough that nobody can post a document. */
const MAX_ENDPOINT = 1000
const MAX_KEY = 300
const MAX_CONTEXT = 60
const MAX_USER_AGENT = 400

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const payload = (req.body ?? {}) as Record<string, unknown>

  const endpoint = text(payload.endpoint, MAX_ENDPOINT)
  const p256dh = text(payload.p256dh, MAX_KEY)
  const auth = text(payload.auth, MAX_KEY)

  if (!endpoint || !p256dh || !auth) {
    res.status(400).json({ ok: false })
    return
  }

  /* Push services are always https. Rejecting anything else costs nothing and keeps a plain http or
     file: URL — which could only have been hand-crafted — out of the send loop entirely. Specific
     hostnames are deliberately not allow-listed: the set changes as browsers do, and a stale list
     would silently stop accepting a whole platform's users. */
  if (!endpoint.startsWith("https://")) {
    res.status(400).json({ ok: false })
    return
  }

  const customerId = text(payload.customerId, 100)
  const context = text(payload.context, MAX_CONTEXT) ?? "unknown"
  const userAgent = text(req.headers["user-agent"], MAX_USER_AGENT) ?? ""

  try {
    await getBakerNetworkDbPool().query(
      `INSERT INTO crossfriend.push_subscribers
         (endpoint, p256dh, auth, customer_id, consent_context, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE
          SET p256dh          = EXCLUDED.p256dh,
              auth            = EXCLUDED.auth,
              customer_id     = COALESCE(EXCLUDED.customer_id, crossfriend.push_subscribers.customer_id),
              consent_context = EXCLUDED.consent_context,
              user_agent      = EXCLUDED.user_agent,
              /**
               * Re-subscribing is a fresh act of consent, so it revives a row that had been retired
               * as dead and one that had been switched off — the same browser returning after a
               * reinstall, and somebody changing their mind, are both cases this must handle.
               *
               * That places the whole weight of the off switch on the client never calling this
               * without a deliberate click. It is the right place for it: refusing revoked rows here
               * would instead mean somebody who turned notifications off could never turn them back
               * on, which is a worse failure and a much harder one to diagnose.
               */
              consented_at    = NOW(),
              revoked_at      = NULL,
              failed_at       = NULL,
              failure_count   = 0`,
      [endpoint, p256dh, auth, customerId, context, userAgent]
    )
  } catch (error) {
    // Includes "the table does not exist yet", which is the state between deploying this and running
    // the migration. A visitor cannot act on any of it, so they are told nothing beyond failure.
    console.error("[push] could not save subscription", error)
    res.status(500).json({ ok: false })
    return
  }

  res.json({ ok: true })
}
