import { addressFingerprint } from "./address"
import {
  countGrants,
  countGrantsToAddress,
  firstGrantAt,
  grantCredit,
  type Brand,
} from "./ledger"
import { evaluateMechanic, type Verdict } from "./limiters"

/**
 * Joining cash: two grants, neither of them at signup.
 *
 * ── The shape, and why it is this shape ────────────────────────────────────────────────────────
 * ₹200 is promised from the moment somebody joins and none of it is issued until they order. The
 * customer sees the figure and feels they hold it, while the balance sheet carries nothing for the
 * people who never buy — which, at a 40% activation rate, is most of them. It also makes the obvious
 * abuse unprofitable: a fraudster has to spend ₹699 on a cake to extract ₹100.
 *
 * Splitting it in two is what buys the repeat the whole model depends on. One ₹200 grant on a first
 * order is a discount; ₹100 now and ₹100 on the next order is a reason to come back.
 *
 * ── What this module decides and what it does not ──────────────────────────────────────────────
 * It decides whether an order earns a grant, which grant it is, and how much — reading every figure
 * from the configuration version in force and stamping that version onto the entry. It does not
 * decide whether the credit can be spent on the order that earned it; that is a redemption question
 * and lives with the checkout work.
 *
 * ── Why the second grant is issued on the second order ─────────────────────────────────────────
 * Not alongside the first. Issuing both at once would put ₹200 in a wallet with nothing tying the
 * second half to a second purchase, which is precisely the discount this design exists to avoid.
 * So the first grant carries a promise with a deadline, and the second is written when the promise
 * is kept. That is also why the limiters step aside for it: an offer that closes in between should
 * not renege on somebody who already acted.
 */

export type JoiningCashOutcome =
  | { granted: false; reason: JoiningCashRefusal; explanation: string }
  | {
      granted: true
      which: 1 | 2
      amountPaise: number
      entryId: string
      expiresAt: Date | null
      /** True when an already-closed offer paid out because it had promised to. */
      honoured: boolean
    }

export type JoiningCashRefusal =
  | "already_complete"
  | "not_prepaid"
  | "below_minimum"
  | "promise_expired"
  | "address_already_claimed"
  | "mechanic_unavailable"

export interface OrderFacts {
  customerId: string
  orderId: string
  brand: Brand
  pincode: string | null
  totalPaise: number
  isPrepaid: boolean
  /**
   * The delivery address, for the one-grant-per-address rule.
   *
   * Optional, and an order without one simply skips that check rather than being refused. A missing
   * address is far more likely to be a pickup, a gift flow or a gap in whatever called this than an
   * attack, and refusing every one of those to catch the rare case would cost more than it saves.
   */
  shippingAddress?: {
    line1?: string | null
    line2?: string | null
    city?: string | null
    postalCode?: string | null
  } | null
  at?: Date
}

const MECHANIC = "joining_cash" as const

/**
 * Would this order earn joining cash, and how much?
 *
 * Separated from the writing so checkout can show the figure before anything is committed, and so
 * the decision can be asserted about in a test without a row appearing anywhere.
 */
export type JoiningCashDecision =
  | { eligible: false; reason: JoiningCashRefusal; explanation: string; verdict?: Verdict }
  | {
      eligible: true
      which: 1 | 2
      amountPaise: number
      expiresAt: Date | null
      verdict: Verdict
      configVersion: number
      addressHash: string | null
    }

export type JoiningCashRefused = Extract<JoiningCashDecision, { eligible: false }>

/**
 * Narrows a decision to its refusal.
 *
 * Written out because this project compiles without `strict`, and without strictNullChecks a plain
 * `if (!decision.eligible)` does not narrow the union — the branch below it still sees both shapes
 * and the compiler rejects reading `reason`. A guard states the discriminant explicitly and works
 * the same whichever way that flag ever goes.
 */
export function isRefused(decision: JoiningCashDecision): decision is JoiningCashRefused {
  return decision.eligible === false
}

/**
 * The same guard for the outcome rather than the decision.
 *
 * Needed for the same reason and by the caller rather than by this file: a subscriber that logs why a
 * grant did not happen has to read `reason`, and without strictNullChecks the compiler still sees both
 * shapes after an `if (outcome.granted) return`.
 */
export function isNotGranted(
  outcome: JoiningCashOutcome
): outcome is Extract<JoiningCashOutcome, { granted: false }> {
  return outcome.granted === false
}

export async function evaluateJoiningCash(order: OrderFacts): Promise<JoiningCashDecision> {
  const at = order.at ?? new Date()
  const already = await countGrants(order.customerId, order.brand, "promo_grant")

  if (already >= 2) {
    return {
      eligible: false,
      reason: "already_complete",
      explanation: "This customer has already had both joining grants.",
    }
  }

  const which: 1 | 2 = already === 0 ? 1 : 2

  /**
   * The second grant completes a promise, so the limiters step aside for it — but only if the
   * promise is still good. The window is the second grant's own expiry, counted from the first
   * grant: "come back within sixty days" is the offer, and honouring it indefinitely would turn a
   * closed campaign into a permanent liability nobody is tracking.
   */
  let honouringPromise = false
  if (which === 2) {
    const firstAt = await firstGrantAt(order.customerId, order.brand, "promo_grant")
    honouringPromise = true

    const probe = await evaluateMechanic({
      brand: order.brand,
      pincode: order.pincode,
      mechanic: MECHANIC,
      at,
      honouringPromise: true,
    })

    const days = Number(probe.config?.params.grant_2_expiry_days ?? 0)
    if (firstAt && days > 0) {
      const deadline = new Date(firstAt.getTime() + days * 86400000)
      if (at > deadline) {
        return {
          eligible: false,
          reason: "promise_expired",
          explanation:
            `The second grant had to be claimed by ${deadline.toISOString().slice(0, 10)}.`,
          verdict: probe,
        }
      }
    }
  }

  const verdict = await evaluateMechanic({
    brand: order.brand,
    pincode: order.pincode,
    mechanic: MECHANIC,
    amountPaise: undefined,
    at,
    honouringPromise,
  })

  if (!verdict.allowed || !verdict.config) {
    return {
      eligible: false,
      reason: "mechanic_unavailable",
      explanation: verdict.explanation ?? "Joining cash is not running here.",
      verdict,
    }
  }

  const params = verdict.config.params
  const amountPaise = Number(which === 1 ? params.grant_1_paise : params.grant_2_paise)
  const minOrder = Number(params.min_order_paise ?? 0)
  const prepaidOnly = params.prepaid_only === true

  /**
   * Eligibility is checked after the mechanic, so a refusal says the most useful thing.
   *
   * "Joining cash is not running here" is what an operator needs; "this order is ₹40 short of the
   * minimum" is what support needs. Checking the offer first means the second message only ever
   * appears when the offer was genuinely available and this particular order missed it.
   */
  if (prepaidOnly && !order.isPrepaid) {
    return {
      eligible: false,
      reason: "not_prepaid",
      explanation: "Joining cash applies to prepaid orders only.",
      verdict,
    }
  }

  if (order.totalPaise < minOrder) {
    return {
      eligible: false,
      reason: "below_minimum",
      explanation:
        `Orders must be at least ₹${(minOrder / 100).toFixed(2)} to earn joining cash.`,
      verdict,
    }
  }

  /**
   * One grant per delivery address.
   *
   * Checked for the FIRST grant only. The second completes a promise to somebody who already
   * qualified, and refusing it because a housemate has since claimed theirs would punish the
   * customer for somebody else's order — after we had already told them the money was coming.
   *
   * Counted across customers, since one mobile is already one customer: the attack this answers is
   * several SIMs delivering to one flat.
   */
  const addressHash = order.shippingAddress
    ? addressFingerprint(order.shippingAddress)
    : null

  if (which === 1 && addressHash) {
    const cap = Number(params.max_per_address ?? 1)
    const already = await countGrantsToAddress(order.brand, "promo_grant", addressHash)
    if (already >= cap) {
      return {
        eligible: false,
        reason: "address_already_claimed",
        explanation:
          cap === 1
            ? "Joining cash has already been claimed at this delivery address."
            : `Joining cash has already been claimed ${cap} times at this delivery address.`,
        verdict,
      }
    }
  }

  /* The budget check is asked about this specific amount, so the last grant cannot overshoot. */
  const affordable = await evaluateMechanic({
    brand: order.brand,
    pincode: order.pincode,
    mechanic: MECHANIC,
    amountPaise,
    at,
    honouringPromise,
  })
  if (!affordable.allowed) {
    return {
      eligible: false,
      reason: "mechanic_unavailable",
      explanation: affordable.explanation ?? "Joining cash is not running here.",
      verdict: affordable,
    }
  }

  /**
   * Only the second grant expires.
   *
   * The first is the one being earned right now and its whole purpose is to be spent; putting a
   * clock on it would mean writing an expiry the customer has no reason to be told about. The
   * second is a deadline by design — it is what turns "you have ₹100" into "come back this month".
   */
  const expiresAt =
    which === 2
      ? new Date(at.getTime() + Number(params.grant_2_expiry_days ?? 60) * 86400000)
      : null

  return {
    eligible: true,
    which,
    amountPaise,
    expiresAt,
    verdict: affordable,
    configVersion: verdict.config.version,
    addressHash,
  }
}

/**
 * Issue the grant this order has earned.
 *
 * Idempotent through the ledger's unique index rather than through a flag: calling it twice for one
 * order writes one entry, because the database refuses the second. Webhooks redeliver and operators
 * click twice, and a flag is one more thing that can disagree with what actually happened.
 */
export async function issueJoiningCash(order: OrderFacts): Promise<JoiningCashOutcome> {
  const decision = await evaluateJoiningCash(order)

  if (isRefused(decision)) {
    return { granted: false, reason: decision.reason, explanation: decision.explanation }
  }

  const entry = await grantCredit({
    customerId: order.customerId,
    entryType: "promo_grant",
    amountPaise: decision.amountPaise,
    brand: order.brand,
    pincode: order.pincode,
    orderId: order.orderId,
    /* Frozen here, so "why did this customer get ₹100" is answerable after the rate moves. */
    configVersion: decision.configVersion,
    expiresAt: decision.expiresAt,
    /* Recorded on the entry so the next order to this address can be checked against it, long
       after the order itself has been archived or its address edited. */
    addressHash: decision.addressHash,
  })

  if (!entry) {
    return {
      granted: false,
      reason: "already_complete",
      explanation: "This order has already earned its joining grant.",
    }
  }

  return {
    granted: true,
    which: decision.which,
    amountPaise: decision.amountPaise,
    entryId: entry.id,
    expiresAt: decision.expiresAt,
    honoured: decision.verdict.honoured === true,
  }
}
