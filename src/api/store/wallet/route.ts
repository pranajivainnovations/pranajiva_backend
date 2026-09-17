import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getHistory, getLots } from "../../../services/wallet/ledger"

/**
 * GET /store/wallet — the signed-in customer's own balance and history.
 *
 * ── Whose wallet ───────────────────────────────────────────────────────────────────────────────
 * The customer id comes from the verified token and from nowhere else. There is no path, parameter
 * or body field that names a customer, so "read someone else's balance" is not a request this route
 * can be made to serve — rather than a check it performs and could later be edited to skip.
 *
 * ── Read-only, structurally ────────────────────────────────────────────────────────────────────
 * GET is the only export. Medusa's file router registers exactly the HTTP methods a route file
 * exports, so this endpoint cannot move money: there is no handler to reach. Credit is written by
 * the reward engine, from a delivered order, and redeemed at checkout — never by something a browser
 * can call.
 *
 * ── What is returned ───────────────────────────────────────────────────────────────────────────
 * A balance, the credit that is going to expire and when, and recent movements. Nothing carries a
 * brand or an order reference: one balance is shared across both storefronts on purpose, and a
 * history line traceable to an order is not. See getHistory for why those columns are omitted
 * outright rather than filtered.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({
      error: "Sign in to see your credit.",
      code: "AUTH_REQUIRED",
    })
    return
  }

  try {
    const [lots, entries] = await Promise.all([
      getLots(customerId),
      getHistory(customerId, Number(req.query.limit ?? 50)),
    ])

    const balancePaise = lots.reduce((sum, lot) => sum + lot.remainingPaise, 0)

    /**
     * Where the balance came from, as remaining amounts rather than totals ever earned.
     *
     * A customer looking at ₹300 wants to know which parts of it are what — the welcome bonus, the
     * credit from a friend's order, the apology from support — because those are different promises
     * with different expiry dates. Summing the grants would answer a different question: what they
     * have been given in total, most of which they may already have spent.
     *
     * Lots are what the resolver spends from, so this is the same arithmetic the checkout does, not a
     * second opinion that could disagree with it.
     */
    const bySource = new Map<string, number>()
    for (const lot of lots) {
      bySource.set(lot.entryType, (bySource.get(lot.entryType) ?? 0) + lot.remainingPaise)
    }

    res.status(200).json({
      balancePaise,
      sources: [...bySource.entries()]
        .map(([type, amountPaise]) => ({ type, amountPaise }))
        .sort((a, b) => b.amountPaise - a.amountPaise),

      /**
       * Only the credit that actually expires, soonest first.
       *
       * getLots already returns spend order, and the lots with no expiry sort last, so filtering
       * preserves the ordering. Credit that never expires is in the balance and needs no date
       * beside it — listing it with "expires: never" invites the reading that the rest is about to
       * disappear.
       */
      expiring: lots
        .filter((lot) => lot.expiresAt !== null)
        .map((lot) => ({ amountPaise: lot.remainingPaise, expiresAt: lot.expiresAt })),

      entries: entries.map((e) => ({
        id: e.id,
        type: e.entryType,
        amountPaise: e.amountPaise,
        at: e.createdAt,
        expiresAt: e.expiresAt,
      })),
    })
  } catch (error) {
    console.error("[store/wallet] failed", error)
    res.status(500).json({ error: "Could not load your credit right now. Please try again." })
  }
}
