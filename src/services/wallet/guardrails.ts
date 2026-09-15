import type { Brand } from "./ledger"
import {
  getEffectiveConfig,
  type EffectiveConfig,
  type Mechanic,
  type NewVersionInput,
} from "./reward-config"

/**
 * Refusing to configure a loss.
 *
 * ── The one rule that shapes everything here ───────────────────────────────────────────────────
 * A guardrail may refuse to START spending money. It must never refuse to STOP. Every check below
 * is skipped entirely when the proposal switches a mechanic off, because the moment somebody needs
 * to stop an offer is the moment they least need an argument with a validation message — and a
 * system that can be talked into paying but not into stopping is worse than one with no guardrails
 * at all.
 *
 * ── Blocks and warnings are different things ───────────────────────────────────────────────────
 * A block is arithmetic that cannot be right: a redemption cap at or above gross margin means every
 * fully discounted order loses money, whatever anybody intended. A warning is a judgement the
 * operator is entitled to make and this code is not — a thin margin, an offer that stacks close to
 * the line. Making everything a block teaches people to find the override; making everything a
 * warning means nobody reads them.
 */

export interface GuardrailResult {
  blocks: string[]
  warnings: string[]
  /** What the numbers work out to, so a screen can show the arithmetic rather than just a verdict. */
  preview: StackingPreview | null
  /**
   * The configurations this verdict was computed from.
   *
   * Carried out so the preview can be recomputed at other order sizes without resolving four
   * configs again, and so a screen can show which mechanics were actually in play — "no cashback
   * is configured" and "cashback is off" produce the same ₹0 and mean different things.
   */
  resolved?: {
    economics: EffectiveConfig | null
    joining: EffectiveConfig | null
    cashback: EffectiveConfig | null
    referral: EffectiveConfig | null
  }
}

export interface StackingPreview {
  orderPaise: number
  marginPaise: number
  promoPaise: number
  cashbackPaise: number
  referralPaise: number
  totalIncentivePaise: number
  netPaise: number
}

const bpsOf = (paise: number, bps: number) => Math.round((paise * bps) / 10000)

/**
 * What every incentive together would cost on one order, if they all fired.
 *
 * Deliberately the worst case rather than the likely one. The order that matters is the one placed
 * by a referred customer, on their first purchase, with joining credit to spend and cashback to
 * earn — rare as a proportion and exactly the order somebody will screenshot when it loses money.
 */
export function stackingPreview(
  economics: EffectiveConfig,
  joining: EffectiveConfig | null,
  cashback: EffectiveConfig | null,
  referral: EffectiveConfig | null,
  atOrderPaise?: number
): StackingPreview | null {
  const orderPaise = atOrderPaise ?? Number(economics.params.assumed_aov_paise ?? 0)
  const marginBps = Number(economics.params.gross_margin_bps ?? 0)
  const capBps = Number(economics.params.promo_redemption_cap_bps ?? 0)
  if (!orderPaise || !marginBps) return null

  /* Promotional credit cannot exceed the cap, however much the customer holds — that is what the
     cap is. So the exposure is the cap, not the grant. */
  const promoPaise =
    joining?.isEnabled ? Math.min(bpsOf(orderPaise, capBps), Number(joining.params.grant_1_paise ?? 0)) : 0

  const cashbackPaise = cashback?.isEnabled
    ? bpsOf(orderPaise, Number(cashback.params.rate_bps ?? 0))
    : 0

  const referralPaise = referral?.isEnabled
    ? Math.min(
        bpsOf(orderPaise, Number(referral.params.rate_bps ?? 0)),
        Number(referral.params.per_order_cap_paise ?? Number.MAX_SAFE_INTEGER)
      )
    : 0

  const marginPaise = bpsOf(orderPaise, marginBps)
  const totalIncentivePaise = promoPaise + cashbackPaise + referralPaise

  return {
    orderPaise,
    marginPaise,
    promoPaise,
    cashbackPaise,
    referralPaise,
    totalIncentivePaise,
    netPaise: marginPaise - totalIncentivePaise,
  }
}

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`

/**
 * Check a proposed configuration version before it is written.
 *
 * Reads the other mechanics as they currently stand and substitutes the proposal for its own, so
 * the stacking check answers the question that matters: what would be true *after* saving this.
 * Checking a mechanic in isolation is how three individually reasonable levers add up to an order
 * that loses money.
 */
export async function checkProposal(
  input: NewVersionInput,
  at: Date = new Date()
): Promise<GuardrailResult> {
  const blocks: string[] = []
  const warnings: string[] = []
  const pincode = input.pincode ?? null

  /**
   * Stopping is always allowed. Always.
   *
   * Returned before anything else is even read, so a guardrail cannot fail closed on a database
   * hiccup and leave somebody unable to switch off an offer that is losing money right now.
   */
  if (!input.isEnabled) {
    return { blocks, warnings, preview: null }
  }

  if (input.mechanic === "economics") {
    const margin = Number(input.params.gross_margin_bps ?? 0)
    const cap = Number(input.params.promo_redemption_cap_bps ?? 0)
    const aov = Number(input.params.assumed_aov_paise ?? 0)

    /**
     * ── Why there is no block here any more ──────────────────────────────────────────────────────
     * The cap used to be refused at or above gross margin, on the reasoning that a fully discounted
     * order would lose money. The arithmetic was right and the conclusion was wrong twice over.
     *
     * First, spending more than an order's margin to win a customer is acquisition cost, which is a
     * decision an operator is entitled to make. Refusing it encoded a judgement as an impossibility.
     *
     * Second, and more to the point: capping redemption never reduced exposure, it only spread it.
     * Credit already granted is already owed. A 15% cap means ₹500 is redeemed across four orders
     * rather than one — the same ₹500, later. What actually bounds the cost is the faucet, not the
     * drain: the per-pincode budget, the grant cap, and the per-customer annual earning limit. Those
     * are real ceilings. This was never one.
     *
     * So the cap is now a single number from 0 to 100%, and the guardrail's job is to say what it
     * costs rather than to refuse it. A cap of 100% lets a wallet pay for an order outright, which
     * is the behaviour that makes credit feel like money instead of a coupon.
     */
    if (cap > margin) {
      const lossPaise = aov ? bpsOf(aov, cap - margin) : 0
      warnings.push(
        `A cap of ${pct(cap)} is ${pct(cap - margin)} above the ${pct(margin)} gross margin` +
          (aov
            ? `, so an order of ${rupees(aov)} paid to the cap costs ${rupees(lossPaise)} more than ` +
              `it earns`
            : "") +
          `. That is acquisition spend, and it is bounded by the budget and grant cap on each ` +
          `mechanic rather than by this number.`
      )
    } else if (margin - cap < 300) {
      warnings.push(
        `The cap (${pct(cap)}) leaves only ${pct(margin - cap)} of margin on a fully discounted ` +
          `order. That is thin enough that a single refund or a delivery reattempt erases it.`
      )
    }

    return { blocks, warnings, preview: null }
  }

  /* Pincode first, falling back to the brand — a launch may loosen the cap in one place. */
  const economics = await getEffectiveConfig(input.brand, pincode, "economics", at)
  if (!economics) {
    blocks.push(
      "This brand has no economics configured, so there is no margin to check this against. " +
        "Set gross margin and the redemption cap first."
    )
    return { blocks, warnings, preview: null }
  }

  /**
   * A budget is mandatory and there is no unlimited option.
   *
   * Checked against the effective configuration rather than the proposal alone, because a pincode
   * row that sets no budget legitimately inherits the brand's. What is refused is a mechanic that
   * is switched on with no ceiling anywhere above it — the state in which the only thing standing
   * between an offer and the bank balance is somebody noticing.
   */
  const effectiveBudget =
    input.budgetPaise ??
    (await getEffectiveConfig(input.brand, pincode, input.mechanic, at))?.budgetPaise ??
    null

  if (effectiveBudget === null) {
    blocks.push(
      "A budget is required before this can be switched on. There is no unlimited option: the " +
        "worst case of an offer with no ceiling is unbounded, and nobody sets out to find out what it is."
    )
  }

  if (input.mechanic === "joining_cash") {
    const grant = Number(input.params.grant_1_paise ?? 0)
    const minOrder = Number(input.params.min_order_paise ?? 0)
    const capBps = Number(economics.params.promo_redemption_cap_bps ?? 0)
    const redeemableOnMin = bpsOf(minOrder, capBps)

    if (grant > 0 && minOrder > 0 && grant > redeemableOnMin) {
      warnings.push(
        `A ${rupees(grant)} grant cannot be fully used on the ${rupees(minOrder)} minimum order — ` +
          `the cap allows only ${rupees(redeemableOnMin)} of it. The rest carries to another order, ` +
          `which is not wrong, but the offer will not feel like ${rupees(grant)} to the customer.`
      )
    }
  }

  /* The proposal stands in for its own mechanic; the others are read as they are. */
  const asProposed = {
    ...(await getEffectiveConfig(input.brand, pincode, input.mechanic, at)),
    isEnabled: input.isEnabled,
    params: input.params,
  } as EffectiveConfig

  const [joining, cashback, referral] = await Promise.all([
    input.mechanic === "joining_cash"
      ? Promise.resolve(asProposed)
      : getEffectiveConfig(input.brand, pincode, "joining_cash", at),
    input.mechanic === "cashback"
      ? Promise.resolve(asProposed)
      : getEffectiveConfig(input.brand, pincode, "cashback", at),
    input.mechanic === "referral"
      ? Promise.resolve(asProposed)
      : getEffectiveConfig(input.brand, pincode, "referral", at),
  ])

  const preview = stackingPreview(economics, joining, cashback, referral)

  if (preview && preview.netPaise < 0) {
    warnings.push(
      `With everything firing, a ${rupees(preview.orderPaise)} order costs ` +
        `${rupees(preview.totalIncentivePaise)} in incentives against ${rupees(preview.marginPaise)} ` +
        `of margin — ${rupees(-preview.netPaise)} more than it earns. If that is acquisition spend ` +
        `it is bounded by the budget; if it is not, one acquisition incentive per order is what ` +
        `stops it — check that cashback is suppressed on promo-discounted orders.`
    )
  } else if (preview && preview.netPaise < preview.marginPaise * 0.25) {
    warnings.push(
      `With everything firing, a ${rupees(preview.orderPaise)} order leaves ` +
        `${rupees(preview.netPaise)} of ${rupees(preview.marginPaise)} margin. It still makes money, ` +
        `but there is very little left for a refund or a second delivery attempt.`
    )
  }

  return { blocks, warnings, preview, resolved: { economics, joining, cashback, referral } }
}

/** Convenience for callers that only want to know whether to stop. */
export function isBlocked(result: GuardrailResult): boolean {
  return result.blocks.length > 0
}

/**
 * The same arithmetic across a range of order sizes.
 *
 * ── Why a range and not just the assumed AOV ───────────────────────────────────────────────────
 * Because the AOV is a placeholder, and an offer that nets ₹20 at ₹800 can be losing money at ₹500
 * and comfortable at ₹1,500 — the referral cap stops scaling while the margin keeps growing, so the
 * shape is not a straight line. One number invites the reading that the offer is either fine or not;
 * a row of them shows where it turns, which is the question an operator is actually asking.
 *
 * Sizes are multiples of the configured AOV rather than fixed rupee amounts, so the range stays
 * meaningful when the real figure finally replaces the assumption.
 */
export function previewAcrossSizes(
  result: GuardrailResult,
  multiples: number[] = [0.5, 1, 1.5, 2]
): StackingPreview[] {
  const { economics, joining, cashback, referral } = result.resolved ?? {}
  if (!economics) return []

  const aov = Number(economics.params.assumed_aov_paise ?? 0)
  if (!aov) return []

  return multiples
    .map((m) =>
      stackingPreview(economics, joining ?? null, cashback ?? null, referral ?? null, Math.round(aov * m))
    )
    .filter((p): p is StackingPreview => p !== null)
}

export type { Mechanic, Brand }
