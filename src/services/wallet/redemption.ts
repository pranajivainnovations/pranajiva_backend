import { getBalance, redeem, type Brand } from "./ledger"
import { getEffectiveConfig } from "./reward-config"

/**
 * How much of an order a customer may pay from their wallet.
 *
 * ── Why the cap is computed here and nowhere else ──────────────────────────────────────────────
 * A cap enforced in the browser is a discount waiting to be edited. Every number below comes from
 * the configuration version in force and the customer's actual balance, both read on the server at
 * the moment of the request; the client's role is to display the answer and, at most, to ask for
 * less than it.
 *
 * ── What the cap is, and what it is not ────────────────────────────────────────────────────────
 * It is the share of an order that credit may cover — one number from 0 to 100%, set per brand and
 * overridable per pincode. It is not a limit on exposure: credit already granted is already owed,
 * and a low cap only spreads its redemption across more orders. What bounds the cost is the budget
 * and the grant cap on each mechanic, which is why this one is free to sit at 100% when that is
 * what the business wants.
 */

export interface RedemptionQuote {
  /** What the customer can actually apply to this order, after every limit. */
  applicablePaise: number
  /** Their whole balance, which may be more than this order can absorb. */
  balancePaise: number
  /** The ceiling this order's value puts on it. */
  capPaise: number
  capBps: number
  /** Why it is not simply the balance, when it is not. */
  limitedBy: "balance" | "cap" | "request" | "nothing_to_apply"
}

/**
 * What could be applied, without writing anything.
 *
 * Called on every checkout render, so it stays two indexed reads. `requestedPaise` lets a customer
 * choose to spend less than they could — keeping credit for a later order is a reasonable thing to
 * want, and a system that always spends the maximum takes that choice away.
 */
export async function quoteRedemption(params: {
  customerId: string
  brand: Brand
  pincode: string | null
  orderTotalPaise: number
  requestedPaise?: number
}): Promise<RedemptionQuote> {
  const economics = await getEffectiveConfig(params.brand, params.pincode, "economics")
  const capBps = Number(economics?.params.promo_redemption_cap_bps ?? 0)

  const balancePaise = Math.max(0, await getBalance(params.customerId))
  const capPaise = Math.floor((params.orderTotalPaise * capBps) / 10000)

  const ceiling = Math.min(balancePaise, capPaise)
  const requested = params.requestedPaise ?? ceiling
  const applicablePaise = Math.max(0, Math.min(ceiling, requested))

  let limitedBy: RedemptionQuote["limitedBy"] = "nothing_to_apply"
  if (applicablePaise > 0) {
    if (requested < ceiling) limitedBy = "request"
    else if (capPaise < balancePaise) limitedBy = "cap"
    else limitedBy = "balance"
  }

  return { applicablePaise, balancePaise, capPaise, capBps, limitedBy }
}

export interface RedemptionResult {
  redeemedPaise: number
  entryId: string | null
  /** What the customer still pays after credit. */
  payablePaise: number
}

/**
 * Spend credit against an order.
 *
 * ── Why the quote is recomputed rather than trusted ────────────────────────────────────────────
 * The caller passes what it believes can be applied, and this treats that only as a ceiling. The
 * balance can change between rendering a checkout and completing it — another tab, an expiry, a
 * clawback — and the cap can change with a configuration save. Recomputing means the worst case of
 * a stale page is applying less than it showed, never more than is owed.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────────────────────────
 * Not enforced here, deliberately. The ledger's unique index covers grants, where a double-write is
 * a double payment; a redemption is different, because an order can legitimately be part-paid,
 * reversed and re-paid. The caller owns "have I already settled this order", because only it knows
 * what settling means for its payment flow.
 */
export async function applyRedemption(params: {
  customerId: string
  brand: Brand
  pincode: string | null
  orderId: string
  orderTotalPaise: number
  requestedPaise?: number
}): Promise<RedemptionResult> {
  const quote = await quoteRedemption(params)

  if (quote.applicablePaise <= 0) {
    return { redeemedPaise: 0, entryId: null, payablePaise: params.orderTotalPaise }
  }

  const result = await redeem({
    customerId: params.customerId,
    requestedPaise: quote.applicablePaise,
    brand: params.brand,
    orderId: params.orderId,
  })

  return {
    redeemedPaise: result.redeemedPaise,
    entryId: result.entryId,
    payablePaise: params.orderTotalPaise - result.redeemedPaise,
  }
}
