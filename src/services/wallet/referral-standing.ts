import { getWalletDbPool } from "./db"
import type { Brand } from "./ledger"

/**
 * What a referrer sees — GS-5.4.
 *
 * ── Why this is honest about the hold rather than optimistic ────────────────────────────────────
 * The tempting screen shows a referrer what they are "going to get" the moment a friend orders. It is
 * also the screen that creates a support queue: an order is delivered, a week passes, a return
 * happens, and money the customer watched accumulate disappears. So each referee sits in exactly one
 * of three states — joined, holding, paid — and the wording says which, rather than adding them into
 * one encouraging total.
 *
 * ── Why a referee is never named ───────────────────────────────────────────────────────────────
 * The referrer knows who they invited; they do not need us to confirm a friend's ordering habits, and
 * a screen that says "Priya ordered a cake on Tuesday" is telling one customer about another. Each row
 * carries a date, a state and an amount. If somebody asks to see names, that is a decision to take
 * deliberately, with the person whose data it is in mind.
 */

export type RefereeState =
  /** Signed up through the link and has not ordered. */
  | "joined"
  /** Ordered and it has been delivered, but the return window has not closed. */
  | "holding"
  /** Paid — the credit is in the referrer's wallet. */
  | "paid"

export interface RefereeStanding {
  joinedAt: Date
  state: RefereeState
  /** Paid so far from this referee. Zero until something clears the hold. */
  earnedPaise: number
  /** Orders of theirs that have been delivered and are still inside the return window. */
  ordersHolding: number
  ordersPaid: number
}

export interface ReferralStanding {
  /** How many people joined through this customer's link. */
  joined: number
  /** Of those, how many have ordered at all. */
  ordered: number
  earnedPaise: number
  /**
   * Deliveries whose return window has not closed.
   *
   * Reported as a count, not an amount. The amount depends on the rate and cap in force when the
   * payout actually runs, and a figure shown now that is smaller later is worse than no figure —
   * see the note at the top of this file.
   */
  holdingOrders: number
  referees: RefereeStanding[]
}

/**
 * Everyone this customer brought, and where each one stands.
 *
 * ── Why "paid" is read from the ledger and not computed from orders ────────────────────────────
 * A payout can be refused for a dozen reasons — the offer stopped, a budget bound, an earning cap —
 * and recomputing what "should" have been paid would show a referrer money they are not getting. The
 * entries are what happened, so the entries are what is shown.
 */
export async function getReferralStanding(params: {
  referrerCustomerId: string
  brand: Brand
}): Promise<ReferralStanding> {
  const { rows } = await getWalletDbPool().query(
    `WITH referees AS (
       SELECT r.customer_id, r.created_at AS joined_at
         FROM wallet.referrals r
        WHERE r.referred_by_customer_id = $1
          AND r.brand = $2
     ),
     delivered AS (
       SELECT bo.order_id, MAX(bo.delivered_at) AS delivered_at
         FROM baker_network.baker_orders bo
        GROUP BY bo.order_id
       HAVING COUNT(*) FILTER (
                WHERE bo.status <> 'rejected' AND bo.delivered_at IS NULL
              ) = 0
          AND COUNT(*) FILTER (WHERE bo.delivered_at IS NOT NULL) > 0
     ),
     /* Every delivered order of every referee, with whether it has paid the referrer yet. */
     orders AS (
       SELECT f.customer_id,
              o.id AS order_id,
              d.delivered_at,
              EXISTS (
                SELECT 1 FROM wallet.entries e
                 WHERE e.customer_id = $1
                   AND e.entry_type = 'referral_earn'
                   AND e.order_id = o.id
                   AND NOT EXISTS (
                     SELECT 1 FROM wallet.entries rv
                      WHERE rv.entry_type = 'reversal' AND rv.source_entry_id = e.id
                   )
              ) AS paid
         FROM referees f
         JOIN public."order" o ON o.customer_id = f.customer_id AND o.canceled_at IS NULL
         JOIN delivered d ON d.order_id = o.id
     ),
     /* What this referrer has actually been paid, per referee. */
     earned AS (
       SELECT o.customer_id, COALESCE(SUM(e.amount_paise), 0)::bigint AS paise
         FROM orders o
         JOIN wallet.entries e
           ON e.order_id = o.order_id
          AND e.customer_id = $1
          AND e.entry_type = 'referral_earn'
          AND NOT EXISTS (
            SELECT 1 FROM wallet.entries rv
             WHERE rv.entry_type = 'reversal' AND rv.source_entry_id = e.id
          )
        GROUP BY o.customer_id
     )
     SELECT f.customer_id,
            f.joined_at,
            COALESCE(ea.paise, 0)::bigint                                        AS earned_paise,
            COUNT(o.order_id) FILTER (WHERE NOT o.paid)::int                     AS orders_holding,
            COUNT(o.order_id) FILTER (WHERE o.paid)::int                         AS orders_paid,
            COUNT(o.order_id)::int                                               AS orders_total
       FROM referees f
       LEFT JOIN orders o ON o.customer_id = f.customer_id
       LEFT JOIN earned ea ON ea.customer_id = f.customer_id
      GROUP BY f.customer_id, f.joined_at, ea.paise
      ORDER BY f.joined_at DESC`,
    [params.referrerCustomerId, params.brand]
  )

  const referees: RefereeStanding[] = rows.map((r) => {
    const ordersPaid = r.orders_paid as number
    const ordersHolding = r.orders_holding as number

    /**
     * One state per referee, most-progressed wins.
     *
     * Somebody with one paid order and one still in its window reads as "paid" rather than "holding",
     * because what they have already produced is the true thing to say about them — and the holding
     * count beside it carries the rest.
     */
    const state: RefereeState =
      ordersPaid > 0 ? "paid" : ordersHolding > 0 ? "holding" : "joined"

    return {
      joinedAt: r.joined_at,
      state,
      earnedPaise: Number(r.earned_paise),
      ordersHolding,
      ordersPaid,
    }
  })

  return {
    joined: referees.length,
    ordered: referees.filter((r) => r.state !== "joined").length,
    earnedPaise: referees.reduce((sum, r) => sum + r.earnedPaise, 0),
    holdingOrders: referees.reduce((sum, r) => sum + r.ordersHolding, 0),
    referees,
  }
}
