import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getOrCreateCode } from "../../../services/wallet/referral-codes"
import { getReferrer } from "../../../services/wallet/referrals"
import { getReferralStanding } from "../../../services/wallet/referral-standing"
import type { Brand } from "../../../services/wallet/ledger"

/**
 * GET /store/referral — the signed-in customer's own code.
 *
 * ── Whose code ─────────────────────────────────────────────────────────────────────────────────
 * The customer id comes from the verified token, like every other authenticated read here. There is
 * no parameter naming a customer, so this cannot be turned into "look up somebody else's code".
 *
 * ── Why no link is returned ────────────────────────────────────────────────────────────────────
 * The backend serves two storefronts and has no business deciding which domain a customer's link
 * points at — a Pranajiva customer handed a crossfriend.in link is a bug that would live in an
 * environment variable. Each storefront knows its own origin and composes the link itself.
 *
 * ── The side effect, and why a GET is allowed to have one ──────────────────────────────────────
 * Minting the code on first read means this route creates a row. That is not the kind of side effect
 * GET forbids: it is idempotent — every subsequent call returns the same code — and it changes
 * nothing the customer could observe as having happened to them. See getOrCreateCode for why it is
 * minted on demand rather than at signup.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({ error: "Sign in to see your referral code.", code: "AUTH_REQUIRED" })
    return
  }

  const brand: Brand = req.query.brand === "pranajiva" ? "pranajiva" : "crossfriend"

  try {
    const [code, referredBy, standing] = await Promise.all([
      getOrCreateCode(customerId),
      getReferrer(customerId),
      getReferralStanding({ referrerCustomerId: customerId, brand }),
    ])

    res.status(200).json({
      code,
      /* Whether this customer arrived through somebody else's link. A boolean rather than the
         referrer's id: who referred you is not the customer's information to receive. */
      wasReferred: referredBy !== null,
      /**
       * How their invitations are going — GS-5.4.
       *
       * Returned with the code rather than from a second endpoint, because the screen that shows one
       * always shows the other, and two calls would mean a card that can render half-loaded.
       */
      standing: {
        joined: standing.joined,
        ordered: standing.ordered,
        earnedPaise: standing.earnedPaise,
        holdingOrders: standing.holdingOrders,
        referees: standing.referees.map((r) => ({
          joinedAt: r.joinedAt,
          state: r.state,
          earnedPaise: r.earnedPaise,
          ordersHolding: r.ordersHolding,
          ordersPaid: r.ordersPaid,
        })),
      },
    })
  } catch (error) {
    console.error("[store/referral] failed", error)
    res.status(500).json({ error: "Could not load your referral code right now." })
  }
}
