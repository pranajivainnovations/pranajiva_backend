import { getWalletDbPool } from "./db"
import { areRewardsGloballyEnabled } from "./settings"
import type { Brand } from "./ledger"
import { getEffectiveConfig, type EffectiveConfig, type Mechanic } from "./reward-config"

/**
 * May this mechanic grant, here, right now?
 *
 * One evaluator for every mechanic, because joining cash, referral and cashback are bounded in
 * exactly the same four ways and the fifth mechanic will be too. Three copies of this logic would
 * be three chances for a budget to be enforced on one lever and forgotten on another — and the one
 * it was forgotten on is the one that keeps paying after the money runs out.
 *
 * ── The four limiters ──────────────────────────────────────────────────────────────────────────
 *   scope    which pincodes the mechanic runs in
 *   window   starts_at / ends_at
 *   count    max_grants
 *   budget   budget_paise
 *
 * Whichever binds first wins and the mechanic simply stops granting. Nothing is raised, nothing
 * needs acknowledging at two in the morning: running out of budget is a planned outcome of setting
 * a budget, not an incident.
 *
 * ── Scope is emergent, not a separate list ─────────────────────────────────────────────────────
 * The spec called for a scope that is "a list, not a flag", and this gets there without a list.
 * A brand default that is switched on runs everywhere; switch the brand default off and enable
 * individual pincode rows and the mechanic runs in exactly those. So "everywhere", "one pincode"
 * and "these four" are all expressible, and adding a pincode to a running offer is one row rather
 * than an edit to a list that something else might be reading at the time.
 *
 * ── A stop and a pause are different events ────────────────────────────────────────────────────
 * `is_enabled` is checked before the limiters and reported as its own kind. An operator switching
 * an offer off and an offer quietly reaching its budget look identical from the outside — both stop
 * paying — and telling them apart afterwards is the difference between "we ended it" and "it ended
 * and nobody noticed".
 */

export type BlockReason =
  | "globally_stopped"
  | "not_configured"
  | "switched_off"
  | "not_in_scope"
  | "not_ready"
  | "not_started"
  | "ended"
  | "grant_cap_reached"
  | "budget_exhausted"

export interface Usage {
  grants: number
  issuedPaise: number
  /** When counting began — see the note on {@link windowStart}. */
  since: Date | null
}

export interface Verdict {
  allowed: boolean
  /** "stopped" is somebody's decision; "paused" is a limit doing its job. */
  kind: "allowed" | "stopped" | "paused" | "unconfigured"
  /**
   * True when this was allowed only because it completes a promise already made.
   *
   * Worth carrying rather than folding into `allowed`, because a grant issued after an offer closed
   * will be asked about, and "we had already promised it" is the answer.
   */
  honoured?: boolean
  reason: BlockReason | null
  /** Plain enough to show an operator without translation. */
  explanation: string | null
  config: EffectiveConfig | null
  usage: Usage
}

const ENTRY_TYPE: Record<Exclude<Mechanic, "economics">, string> = {
  joining_cash: "promo_grant",
  referral: "referral_earn",
  cashback: "cashback_earn",
}

/**
 * The moment counting starts for the count and budget limiters.
 *
 * `starts_at` when the offer has one, otherwise the beginning of time.
 *
 * The consequence is worth stating plainly, because it is the behaviour an operator will rely on:
 * raising a budget mid-offer lets more through against the same running total, while giving an
 * offer a NEW start date gives it a fresh budget. Keying the window on the config version instead
 * would mean any edit — a rate change, a typo in a note — silently reset the spend to zero, which
 * is the kind of reset nobody intends and nobody notices until the money is gone.
 */
function windowStart(config: EffectiveConfig): Date | null {
  return config.startsAt ?? null
}

async function getUsage(
  brand: Brand,
  pincode: string | null,
  mechanic: Exclude<Mechanic, "economics">,
  since: Date | null
): Promise<Usage> {
  const { rows } = await getWalletDbPool().query(
    `SELECT COUNT(*)::int AS grants,
            COALESCE(SUM(amount_paise), 0)::bigint AS issued
       FROM wallet.entries
      WHERE brand = $1
        AND entry_type = $2
        AND pincode IS NOT DISTINCT FROM $3
        AND ($4::timestamptz IS NULL OR created_at >= $4)`,
    [brand, ENTRY_TYPE[mechanic], pincode, since]
  )

  return {
    grants: rows[0].grants,
    issuedPaise: Number(rows[0].issued),
    since,
  }
}

const EMPTY_USAGE: Usage = { grants: 0, issuedPaise: 0, since: null }

/** A pincode is ready when this many bakers are live there with something published. */
export const READINESS_BAKERS = 3

/**
 * How many bakers can actually take an order in a pincode.
 *
 * Live on the storefront and holding at least one published product — not merely present in the
 * database. The distinction is the whole check: there are six bakers on file today and five of them
 * are in 201016, but every one is a prospect with nothing published, so the honest count there is
 * zero.
 *
 * Counted rather than cached, because a baker going quiet is exactly the event that should close an
 * offer, and a cached number would keep it open.
 */
export async function readyBakerCount(pincode: string): Promise<number> {
  const { rows } = await getWalletDbPool().query(
    `SELECT COUNT(DISTINCT b.id)::int AS n
       FROM baker_network.bakers b
       JOIN baker_network.baker_products p ON p.baker_id = b.id
      WHERE b.is_active = TRUE
        AND b.is_public = TRUE
        AND p.publication_state = 'published'
        AND (b.pincode = $1 OR $1 = ANY(COALESCE(b.serviceable_pincodes, ARRAY[]::text[])))`,
    [pincode]
  )
  return rows[0].n
}

/**
 * Evaluate every limiter for one mechanic in one place.
 *
 * `amountPaise` is the grant being considered, when there is one. Passing it makes the budget check
 * ask the question that actually matters — "would this grant take us past the budget?" — rather than
 * "are we past it already", which lets the last grant overshoot by its own value.
 */
export async function evaluateMechanic(params: {
  brand: Brand
  pincode: string | null
  mechanic: Exclude<Mechanic, "economics">
  amountPaise?: number
  at?: Date
  /**
   * This grant completes something the customer was already promised.
   *
   * Joining cash is two grants: taking the first tells the customer a second is coming on their
   * next order. If the offer closes in between — the budget binds, the end date passes, somebody
   * switches it off — the honest thing is to pay what was promised. Stopping an offer stops making
   * NEW promises; it does not withdraw one already made, any more than it claws back credit already
   * granted.
   *
   * The caller decides what counts as a continuation, because only it knows the shape of its own
   * chain. What this function guarantees is that the limiters step aside for one and the global stop
   * does not.
   */
  honouringPromise?: boolean
  /**
   * Delivery already happened, so the readiness bar has nothing left to protect.
   *
   * Readiness exists to stop us paying to acquire customers in a pincode nothing can be delivered
   * from. A reward earned on an order that was delivered a week ago is the opposite case: that
   * pincode demonstrably delivered, and the money is owed for something that already went right.
   * Blocking it because a baker has since unpublished a product would withhold a commission on a
   * cake that arrived, for a reason that is about future orders.
   *
   * Deliberately narrow, and deliberately not `honouringPromise`, which steps past the operator
   * switch, the budget and the end date as well. Those must keep applying: stopping referral has to
   * stop referral payments, and a budget that has bound has to bind. This skips one check, the only
   * one that is asking a question already answered.
   */
  supplyAlreadyProven?: boolean
}): Promise<Verdict> {
  const at = params.at ?? new Date()

  /**
   * The global stop, checked before anything else is read.
   *
   * First because it has to work when the configuration itself is the problem — a version that
   * resolves to something nobody expected, a merge nobody predicted. Everything below this line
   * depends on that machinery being sane; this line does not.
   */
  if (!(await areRewardsGloballyEnabled())) {
    return {
      allowed: false,
      kind: "stopped",
      reason: "globally_stopped",
      explanation: "All rewards are switched off.",
      config: null,
      usage: EMPTY_USAGE,
    }
  }

  const config = await getEffectiveConfig(params.brand, params.pincode, params.mechanic, at)

  if (!config) {
    return {
      allowed: false,
      kind: "unconfigured",
      reason: "not_configured",
      explanation: "This reward has never been configured for this brand.",
      config: null,
      usage: EMPTY_USAGE,
    }
  }

  const usage = await getUsage(params.brand, params.pincode, params.mechanic, windowStart(config))
  const blocked = (reason: BlockReason, explanation: string, kind: "stopped" | "paused"): Verdict => ({
    allowed: false,
    kind,
    reason,
    explanation,
    config,
    usage,
  })

  /**
   * A promise already made is kept, whatever the limiters now say.
   *
   * Placed after the configuration is read — so the rate and expiry still come from the version in
   * force — and after the global stop, which is the one thing that overrides even this. The global
   * switch exists for "something is wrong right now", and in the case it is actually reached for,
   * fraud, honouring promises made to the accounts being investigated is precisely wrong. Every
   * other stop is a planned event that should not break faith with a customer who already acted.
   */
  if (params.honouringPromise) {
    return {
      allowed: true,
      kind: "allowed",
      honoured: true,
      reason: null,
      explanation: null,
      config,
      usage,
    }
  }

  /* Then, and reported as its own kind: somebody turned this off. */
  if (!config.isEnabled) {
    return blocked("switched_off", "This reward is switched off here.", "stopped")
  }

  /**
   * And then: is this one of the pincodes it was switched on for?
   *
   * ── Why this is not the same question as "is it enabled" ─────────────────────────────────────
   * A brand-level offer used to be on everywhere the moment it was on anywhere, and the only trace of
   * that decision was its absence. Now the brand row names where it runs, and a pincode that is not
   * named is not served — which is a different sentence from "somebody stopped it here", and is
   * reported as one so an operator looking at a quiet pincode can tell the two apart.
   *
   * ── Why an explicit pincode row still wins ───────────────────────────────────────────────────
   * The check runs only when the enablement came from the brand. A pincode-level version exists
   * because somebody created it, and creating one is the act of deciding what happens there — so a
   * pilot can be switched on in one pincode without touching the list, and switched off in another
   * without editing the list either. The list is the answer for pincodes that have said nothing.
   */
  if (params.pincode && config.source.isEnabled === "brand" && config.scopeMode === "selected") {
    const scope = config.scopePincodes ?? []
    if (!scope.includes(params.pincode)) {
      return blocked(
        "not_in_scope",
        scope.length === 0
          ? "This reward is switched on but has no pincodes selected, so it runs nowhere."
          : `This reward runs in ${scope.join(", ")}, and ${params.pincode} is not one of them.`,
        "stopped"
      )
    }
  }

  /**
   * The readiness bar, checked after the operator switch and before the limiters.
   *
   * Paying to acquire customers in a pincode nothing can be delivered from buys negative word of
   * mouth at a premium — in this category a failure is not a bad purchase, it is a ruined occasion,
   * in a dense residential area where neighbours talk.
   *
   * It gates where a mechanic SERVES, never whether it can be configured or switched off, which is
   * what makes a scope of "everywhere" safe to set: unready pincodes simply do not serve, and say
   * why, rather than the operator having to know in advance which ones are ready.
   *
   * Brand-level evaluation with no pincode skips it. That is a report or a preview asking about the
   * mechanic in general, not an order about to be placed somewhere.
   */
  if (params.pincode && !params.supplyAlreadyProven) {
    const bakers = await readyBakerCount(params.pincode)
    if (bakers < READINESS_BAKERS) {
      return blocked(
        "not_ready",
        `${params.pincode} has ${bakers} of the ${READINESS_BAKERS} bakers needed before rewards ` +
          `run here — a baker is counted only when they are live and have published a product.`,
        "paused"
      )
    }
  }

  if (config.startsAt && at < config.startsAt) {
    return blocked(
      "not_started",
      `This reward opens on ${config.startsAt.toISOString().slice(0, 10)}.`,
      "paused"
    )
  }

  if (config.endsAt && at >= config.endsAt) {
    return blocked(
      "ended",
      `This reward closed on ${config.endsAt.toISOString().slice(0, 10)}.`,
      "paused"
    )
  }

  if (config.maxGrants !== null && usage.grants >= config.maxGrants) {
    return blocked(
      "grant_cap_reached",
      `All ${config.maxGrants} of these rewards have been claimed.`,
      "paused"
    )
  }

  if (config.budgetPaise !== null) {
    const wouldReach = usage.issuedPaise + (params.amountPaise ?? 0)
    if (wouldReach > config.budgetPaise) {
      return blocked(
        "budget_exhausted",
        `The budget for this reward is spent ` +
          `(₹${(usage.issuedPaise / 100).toFixed(2)} of ₹${(config.budgetPaise / 100).toFixed(2)}).`,
        "paused"
      )
    }
  }

  return { allowed: true, kind: "allowed", reason: null, explanation: null, config, usage }
}

export interface Headroom {
  grantsRemaining: number | null
  budgetRemainingPaise: number | null
}

/**
 * What is left before a limiter binds, for a screen that shows "142 of 200 · ₹28,400 of ₹40,000".
 *
 * Null where no limit is set, which reads as "no ceiling" rather than as zero — the distinction a
 * progress bar has to get right, since an unlimited mechanic rendered as 0-remaining looks exhausted.
 */
export function headroomFrom(verdict: Verdict): Headroom {
  if (!verdict.config) return { grantsRemaining: null, budgetRemainingPaise: null }
  return {
    grantsRemaining:
      verdict.config.maxGrants === null
        ? null
        : Math.max(0, verdict.config.maxGrants - verdict.usage.grants),
    budgetRemainingPaise:
      verdict.config.budgetPaise === null
        ? null
        : Math.max(0, verdict.config.budgetPaise - verdict.usage.issuedPaise),
  }
}
