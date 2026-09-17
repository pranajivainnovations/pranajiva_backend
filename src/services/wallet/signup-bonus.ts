import { getWalletDbPool } from "./db"
import { grantCredit, type Brand } from "./ledger"
import { evaluateMechanic } from "./limiters"

/**
 * Credit for joining — GS extension to Phase 4.
 *
 * ── How this differs from joining cash, and why that matters ───────────────────────────────────
 * Joining cash is earned: two grants, each unlocked by an order. That is what makes it safe — a
 * fraudster has to buy a ₹699 cake to extract ₹100, so the attack costs more than it pays. This pays
 * for an account and nothing else, which is a genuinely different instrument. It exists because a
 * campaign sometimes needs to put something in a customer's hand before they have done anything, and
 * it is bounded by different things: a budget, a grant cap, and an expiry short enough that the
 * credit is a reason to order rather than a number sitting on the books.
 *
 * ── Why the pincode is taken on trust, and what that is allowed to decide ──────────────────────
 * A customer has no address when they join, so the only area we have is the one they typed into the
 * storefront to see what was available. It is a claim, not a verified fact — somebody can type
 * whichever pincode has the better offer. That is deliberately survivable: the credit can only ever
 * be spent on a real order to a real address, so the worst case is a customer in one serviced area
 * claiming another's offer, and the budget and grant cap bound that.
 *
 * What it must never do is decide a payout. Joining cash, referral and cashback all read the pincode
 * off the delivered order, and they continue to.
 *
 * ── Why running twice grants once ──────────────────────────────────────────────────────────────
 * A unique index on (customer_id, brand) for this entry type. A sign-in can be retried, a request can
 * be redelivered, and an operator can run a backfill over accounts that predate the campaign; none of
 * those may pay twice, and none of them has to remember not to.
 */

const MECHANIC = "signup_bonus" as const

export type SignupBonusOutcome =
  | { granted: true; amountPaise: number; entryId: string; expiresAt: Date }
  | { granted: false; reason: SignupBonusRefusal; explanation: string }

export type SignupBonusRefusal =
  | "already_granted"
  | "mechanic_unavailable"
  | "not_configured"
  /** They never told us where they are, and the offer only runs in named pincodes. */
  | "area_unknown"

export function isNotGranted(
  outcome: SignupBonusOutcome
): outcome is Extract<SignupBonusOutcome, { granted: false }> {
  return outcome.granted === false
}

/** Whether this customer has already had one on this brand. */
export async function hasSignupBonus(customerId: string, brand: Brand): Promise<boolean> {
  const { rows } = await getWalletDbPool().query(
    `SELECT 1 FROM wallet.entries
      WHERE customer_id = $1 AND brand = $2 AND entry_type = 'signup_bonus'
      LIMIT 1`,
    [customerId, brand]
  )
  return rows.length > 0
}

/**
 * Issues the bonus, if one is running.
 *
 * ── What the declared pincode decides ──────────────────────────────────────────────────────────
 * Where the bonus runs, and whether this customer is inside it. The storefront asks every arriving
 * visitor, so by sign-in we usually know — and somebody who skipped the question gets nothing when
 * the offer is scoped to named pincodes, because an offer running in three areas cannot be handed to
 * a person who might be in any of thirty thousand.
 *
 * It also brings the readiness bar with it: paying somebody to join in a pincode nothing can be
 * delivered from buys an account that can never become an order.
 */
export async function issueSignupBonus(params: {
  customerId: string
  brand: Brand
  /** What the visitor told the storefront, if anything. Never trusted for a payout. */
  pincode?: string | null
  at?: Date
}): Promise<SignupBonusOutcome> {
  const at = params.at ?? new Date()
  const pincode = params.pincode && /^[1-9][0-9]{5}$/.test(params.pincode) ? params.pincode : null

  if (await hasSignupBonus(params.customerId, params.brand)) {
    return {
      granted: false,
      reason: "already_granted",
      explanation: "This customer has already had a joining bonus.",
    }
  }

  const verdict = await evaluateMechanic({
    brand: params.brand,
    pincode,
    mechanic: MECHANIC,
    at,
  })

  /**
   * An offer that runs in named pincodes cannot be given to somebody who might be anywhere.
   *
   * A visitor who skipped the pincode prompt reaches here with nothing, and the scope check in the
   * evaluator is skipped for a null pincode — correctly, because at brand level that call is a report
   * rather than a customer. So the case is decided here, where it is a customer: no area, no bonus.
   *
   * Said as its own reason rather than folded into "unavailable", because it is the one refusal that
   * is entirely within the customer's power to fix, and the only one worth a different sentence on a
   * screen. A scope of every pincode is how an operator chooses the opposite behaviour.
   */
  if (!pincode && verdict.config?.scopeMode === "selected") {
    return {
      granted: false,
      reason: "area_unknown",
      explanation:
        "This bonus runs in particular pincodes, and this customer has not told us where they are.",
    }
  }

  if (!verdict.allowed || !verdict.config) {
    return {
      granted: false,
      reason: verdict.reason === "not_configured" ? "not_configured" : "mechanic_unavailable",
      explanation: verdict.explanation ?? "No joining bonus is running.",
    }
  }

  const amountPaise = Number(verdict.config.params.amount_paise ?? 0)
  const expiryDays = Number(verdict.config.params.expiry_days ?? 0)

  if (!amountPaise || amountPaise <= 0 || !expiryDays) {
    return {
      granted: false,
      reason: "not_configured",
      explanation: "The joining bonus is switched on but has no amount or expiry set.",
    }
  }

  const expiresAt = new Date(at.getTime() + expiryDays * 86_400_000)

  const entry = await grantCredit({
    customerId: params.customerId,
    entryType: "signup_bonus",
    amountPaise,
    brand: params.brand,
    /* Stamped when we have one, so the outcomes panel can attribute the spend to an area. Null is a
       truthful "they did not say", not a default pincode. */
    pincode,
    configVersion: verdict.config.version,
    expiresAt,
  })

  if (!entry) {
    /* The unique index refused it — another request got there first. Not an error, and not a second
       payment. */
    return {
      granted: false,
      reason: "already_granted",
      explanation: "This customer has already had a joining bonus.",
    }
  }

  return { granted: true, amountPaise, entryId: entry.id, expiresAt }
}
