import { countGrants } from "./ledger"
import type { Brand } from "./ledger"
import { evaluateMechanic } from "./limiters"

/**
 * The "₹100 on your first order, ₹100 on your second" ladder, answered for one customer.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────────────────────────
 * The account screen promises a specific sum of money — "₹200 is waiting for you" — and until now it
 * promised it from a string typed into a React component. Three things make that a lie in production
 * today, and none of them are visible from the storefront:
 *
 *   1. The amounts are a setting. `grant_1_paise` and `grant_2_paise` are ₹100 each right now and an
 *      operator may change either this afternoon. A hardcoded ₹200 would keep saying ₹200.
 *   2. The offer runs in named pincodes. `joining_cash` is scoped to a list — one pincode as things
 *      stand — so for a customer anywhere else the correct number is nothing, not ₹200.
 *   3. There is a minimum order. `min_order_paise` is ₹699, so "unlocks on your first order" is not
 *      true of a ₹400 order, and somebody who places one has been told otherwise.
 *
 * So the ladder is read from the configuration that actually governs it, for the area the customer
 * is actually in, and the screen renders whatever comes back — including nothing.
 *
 * ── Why the verdict engine decides, rather than a config read ──────────────────────────────────
 * `evaluateMechanic` is what the payout path itself asks. Using it here means the screen cannot
 * promise money the engine would refuse to pay: a switched-off mechanic, an exhausted budget, an
 * area with no bakers ready to deliver, an offer that has not started. A plain config read would
 * answer "the offer exists" when the honest answer is "it exists and you would not receive it".
 *
 * ── Why unlocked steps are counted from the ledger ─────────────────────────────────────────────
 * Not from an order count. The question the screen is asking is "how much of this have I actually
 * been given", and the ledger is the only thing that knows — an order that was refunded, or one that
 * fell below the minimum, produced no grant and must not light up a segment.
 */

export interface LadderStep {
  amountPaise: number
  /** Already in the wallet — this one has been paid. */
  unlocked: boolean
}

export type LadderBlocked =
  /** They have not told us where they are, and the offer only runs in named areas. */
  | "no_pincode"
  /** We know where they are, and it is not one of those areas. */
  | "not_in_area"
  /** Running somewhere, but not payable right now — switched off, out of budget, not yet started. */
  | "unavailable"
  /** No joining-cash offer is configured on this brand at all. */
  | "not_configured"

export interface GrantLadder {
  /** True only when a customer standing here today would actually be paid. */
  running: boolean
  /** Why not, when it is not — so the screen can say the right sentence rather than a generic one. */
  blocked: LadderBlocked | null
  steps: LadderStep[]
  /** The whole ladder, paid and unpaid together. Zero when nothing is running. */
  totalPaise: number
  /** What is left to earn. This is the figure worth putting in front of somebody. */
  remainingPaise: number
  /** The order value each step needs, or 0 when there is no minimum. */
  minOrderPaise: number
  unlockedCount: number
}

const NOTHING: GrantLadder = {
  running: false,
  blocked: "not_configured",
  steps: [],
  totalPaise: 0,
  remainingPaise: 0,
  minOrderPaise: 0,
  unlockedCount: 0,
}

export async function getGrantLadder(params: {
  customerId: string
  brand: Brand
  /** Whatever the customer has told us, which may well be nothing. */
  pincode: string | null
}): Promise<GrantLadder> {
  const pincode =
    params.pincode && /^[1-9][0-9]{5}$/.test(params.pincode) ? params.pincode : null

  const [unlockedCount, verdict] = await Promise.all([
    countGrants(params.customerId, params.brand, "promo_grant"),
    evaluateMechanic({ brand: params.brand, pincode, mechanic: "joining_cash" }),
  ])

  const config = verdict.config
  if (!config) return { ...NOTHING, unlockedCount }

  const amounts = [
    Number(config.params.grant_1_paise ?? 0),
    Number(config.params.grant_2_paise ?? 0),
  ].filter((n) => n > 0)

  if (amounts.length === 0) return { ...NOTHING, unlockedCount }

  const steps: LadderStep[] = amounts.map((amountPaise, i) => ({
    amountPaise,
    unlocked: i < unlockedCount,
  }))

  const totalPaise = amounts.reduce((sum, n) => sum + n, 0)
  const remainingPaise = steps
    .filter((s) => !s.unlocked)
    .reduce((sum, s) => sum + s.amountPaise, 0)

  const base = {
    steps,
    totalPaise,
    remainingPaise,
    minOrderPaise: Number(config.params.min_order_paise ?? 0),
    unlockedCount,
  }

  /**
   * No area, and the offer runs only in named ones.
   *
   * Said as its own answer rather than folded into "unavailable" because it is the single refusal
   * the customer can fix themselves, and the screen has a useful thing to say about it. The amounts
   * still come back: at brand level they are the defaults a named pincode would inherit, so "₹200 is
   * waiting in your area — tell us where you are" is a truthful sentence to build from.
   */
  if (!pincode && config.scopeMode === "selected") {
    return { ...base, running: false, blocked: "no_pincode" }
  }

  if (!verdict.allowed) {
    return {
      ...base,
      running: false,
      blocked: verdict.reason === "not_in_scope" ? "not_in_area" : "unavailable",
    }
  }

  return { ...base, running: true, blocked: null }
}
