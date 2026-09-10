import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"

/**
 * POST /store/pincode/waitlist   { pincode, mobile, source? }
 *
 * "Tell me when you deliver here."
 *
 * ── Why this is worth an endpoint ──────────────────────────────────────────────────────────────
 * Delivery is live in a handful of pincodes, so most people who type one are told we cannot reach
 * them. Designing stays free everywhere, which keeps the visit worth something — but the pincode
 * itself is the more valuable thing to keep, because a queue of real numbers per pincode is the
 * evidence OPS needs to decide which area to launch next. See the migration for the table's shape.
 *
 * ── An unauthenticated write, and what bounds it ───────────────────────────────────────────────
 * Public by necessity: nobody signs in to be told a bakery opened near them. Three things keep it
 * cheap to abuse and pointless to try, in the same spirit as push/subscribe.
 *
 * (pincode, mobile) is unique and the insert upserts, so a caller repeating one body forever writes
 * one row. Both columns are constrained to their exact shapes in the database as well as here, so
 * the table cannot be filled with junk of arbitrary size. And a row grants nothing — it is not an
 * account and cannot be logged in to; its only power is to receive one message we choose to send.
 *
 * ── Why the response never says whether the row was new ────────────────────────────────────────
 * Always `{ ok: true }`. "You're already on the list" would let anyone test whether a given mobile
 * number is waiting on a given pincode, which is a question no stranger should be able to ask about
 * someone else's number.
 */

const MAX_SOURCE = 40

/** Where the ask came from, restricted to values we actually emit. */
const ALLOWED_SOURCES = new Set(["studio", "product", "checker", "unknown"])

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const payload = (req.body ?? {}) as Record<string, unknown>

  const pincode = String(payload.pincode ?? "").trim()
  const mobile = String(payload.mobile ?? "").trim()
  const rawSource = String(payload.source ?? "unknown").trim().slice(0, MAX_SOURCE)
  const source = ALLOWED_SOURCES.has(rawSource) ? rawSource : "unknown"

  if (!/^\d{6}$/.test(pincode)) {
    res.status(400).json({ error: "Please enter a valid 6-digit pincode" })
    return
  }

  /* The same rule the OTP sign-in uses, so a number accepted here is one we could actually message. */
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    res.status(400).json({ error: "Please enter a valid 10-digit mobile number" })
    return
  }

  /* Recorded when the caller happens to be signed in, never required and never joined on. */
  const customerId =
    typeof (req as { user?: { customer_id?: string } }).user?.customer_id === "string"
      ? (req as { user?: { customer_id?: string } }).user!.customer_id!
      : null

  try {
    const db = getBakerNetworkDbPool()

    /* created_at deliberately untouched on conflict: how long somebody has been waiting is the
       thing that makes this list persuasive, and overwriting it on every repeat visit would reset
       every queue to "just arrived". last_asked_at carries the recency instead. */
    await db.query(
      `INSERT INTO crossfriend.pincode_waitlist (pincode, mobile, customer_id, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pincode, mobile) DO UPDATE
         SET last_asked_at = NOW(),
             customer_id = COALESCE(crossfriend.pincode_waitlist.customer_id, EXCLUDED.customer_id)`,
      [pincode, mobile, customerId, source]
    )

    res.status(200).json({ ok: true })
  } catch (error) {
    console.error("[API /store/pincode/waitlist] Error:", error)
    res.status(500).json({ error: "Couldn't save that just now. Please try again." })
  }
}
