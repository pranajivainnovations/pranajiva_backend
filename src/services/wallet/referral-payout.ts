import { addressFingerprint } from "./address"
import { getWalletDbPool } from "./db"
import { grantCredit, type Brand } from "./ledger"
import { evaluateMechanic } from "./limiters"
import { getEffectiveConfig } from "./reward-config"

/**
 * Paying a referrer — GS-5.2.
 *
 * ── Why this is a sweep and not an event ───────────────────────────────────────────────────────
 * The reward is owed a week after delivery, and "a week after delivery" is not something that
 * happens; it is a date arriving. There is no event to subscribe to. So the shape of this mechanic is
 * a job that asks "what has come due" rather than a handler that reacts, and everything here is
 * written to be run repeatedly, out of order, and after a missed night, because a scheduled job is
 * the least trustworthy part of any system.
 *
 * ── Why the hold exists at all ─────────────────────────────────────────────────────────────────
 * Paying on delivery would mean paying on orders that are about to be returned, and credit that has
 * already been spent cannot be taken back without taking it from a customer who did nothing wrong.
 * Waiting out the return window costs the referrer a few days of patience and costs us nothing.
 *
 * ── What "order value" means here, and why it is not the whole total ───────────────────────────
 * Commission is paid on the cake, not on the courier. Delivery is close to a pass-through cost, so
 * five percent of it is five percent of money that was never ours — and it would mean a referrer
 * earns more from a distant delivery than a nearby one, which is not a behaviour worth paying for.
 * The value is supplied by the caller (see OrderValueResolver) because Medusa computes an order's
 * total from its line items rather than storing one, and only the application layer can ask it.
 *
 * ── What this does not do ──────────────────────────────────────────────────────────────────────
 * The per-address and per-customer earning caps are GS-5.3. This enforces the payout rules and the
 * OPS switch, budget and grant cap that every mechanic goes through; it does not yet bound what one
 * very energetic referrer can accumulate. The delivery address is stamped on every entry so that
 * when those caps arrive they have history to work from — a cap added later against data that was
 * never recorded would start from zero and forgive everything that came before it.
 */

const MECHANIC = "referral" as const

/**
 * The widest window any configuration can ask for, from the field catalogue's own maximum.
 *
 * The candidate query cannot know which configuration applies to a given order — that depends on the
 * order's pincode, and resolving config per row inside SQL would mean the rules living in two places.
 * So the query is deliberately generous and the engine narrows it afterwards, using the
 * configuration actually in force for that scope.
 */
const MAX_WINDOW_ORDERS = 10

/**
 * How far back a nightly run will look.
 *
 * Unpaid orders drop out of the candidate set as soon as they are paid, so the set stays small by
 * itself — but orders that are permanently ineligible, because referral was never switched on where
 * they were delivered, never drop out and would make every night's scan a little larger forever.
 *
 * Four months is far past any hold the catalogue permits (sixty days) plus a generous allowance for
 * a job that was broken and got fixed. Something older than this needs somebody to decide to pay it,
 * not a job quietly discovering it a year later.
 */
const LOOKBACK_DAYS = 120

/**
 * What an order is worth for commission, in paise, or null if it cannot be determined.
 *
 * Injected rather than computed here because every other service in this directory talks to Postgres
 * and nothing else, while an order's total exists only once Medusa's totals service has assembled it.
 * Keeping the dependency at the edge means this engine stays testable without a container, and the
 * one place that knows about Medusa is the job.
 *
 * Returning null skips the order rather than paying zero: an order whose value we could not read is
 * not an order worth nothing.
 */
export type OrderValueResolver = (orderId: string) => Promise<number | null>

export interface DuePayout {
  /** Who gets paid. */
  referrerCustomerId: string
  /** Whose order earned it. */
  refereeCustomerId: string
  orderId: string
  /** Which of the referee's delivered orders this is — 1 for their first. */
  orderRank: number
  deliveredAt: Date
  pincode: string | null
  brand: Brand
  addressHash: string | null
}

export type PayoutOutcome =
  | { paid: true; entryId: string; amountPaise: number; valuePaise: number }
  | { paid: false; reason: PayoutRefusal; explanation: string }

export type PayoutRefusal =
  | "outside_window"
  | "still_on_hold"
  | "mechanic_unavailable"
  | "no_order_value"
  | "rounds_to_nothing"
  | "already_paid"
  /* GS-5.3 — the three that bound one person rather than one offer. */
  | "address_cap_reached"
  | "monthly_cap_reached"
  | "annual_cap_reached"

export type PayoutDecision =
  | { owed: false; reason: PayoutRefusal; explanation: string }
  | { owed: true; amountPaise: number; valuePaise: number; configVersion: number }

/**
 * Narrows these unions to their refusal.
 *
 * Written out because this project compiles without `strict`, and without strictNullChecks a plain
 * `if (!decision.owed)` does not narrow — the branch below it still sees both shapes and the compiler
 * rejects reading `reason`. The joining cash engine carries the same pair of guards for the same
 * reason; see isRefused there.
 */
export function isNotOwed(
  decision: PayoutDecision
): decision is Extract<PayoutDecision, { owed: false }> {
  return decision.owed === false
}

export function isUnpaid(
  outcome: PayoutOutcome
): outcome is Extract<PayoutOutcome, { paid: false }> {
  return outcome.paid === false
}

/**
 * Which brand an order belongs to.
 *
 * Read from the sales channel, which is the only place a Medusa order records which storefront it
 * came from. Matched on the channel's name rather than its id, because the ids differ between the
 * production database and any other, and a hardcoded id would silently stop matching in the one
 * place that is hardest to notice.
 *
 * Falls back to the brand on the referral edge when an order has no channel — which is true of
 * orders predating the second storefront. That is a documented approximation rather than a guess: it
 * pays at the rate of the brand the customer was referred to, which is the brand that made the offer.
 */
function brandOfOrder(channelName: string | null, referralBrand: Brand): Brand {
  if (channelName === "pranajiva") return "pranajiva"
  if (channelName === "crossfriend") return "crossfriend"
  return referralBrand
}

/**
 * Everything that might be owed, newest delivery last.
 *
 * ── Why the rank is computed before the unpaid filter ──────────────────────────────────────────
 * "The first three delivered orders" has to mean the first three, not the first three that happen to
 * be unpaid. Filtering out paid orders and then ranking would promote a fourth order into third
 * place the moment the third was paid, and the referrer would be paid on every order forever.
 *
 * ── What counts as delivered ───────────────────────────────────────────────────────────────────
 * Every baker working an order has marked it delivered, and at least one has. A part-delivered order
 * is not delivered: paying on it would pay before the customer has what they ordered, which is the
 * one thing the hold exists to prevent. Rejected assignments are excluded from that test, because an
 * order reassigned after a rejection would otherwise never qualify.
 */
export async function findDuePayouts(params: {
  at?: Date
  limit?: number
}): Promise<DuePayout[]> {
  const at = params.at ?? new Date()
  const limit = params.limit ?? 500

  const { rows } = await getWalletDbPool().query(
    `WITH delivered AS (
       SELECT bo.order_id, MAX(bo.delivered_at) AS delivered_at
         FROM baker_network.baker_orders bo
        GROUP BY bo.order_id
       HAVING COUNT(*) FILTER (
                WHERE bo.status <> 'rejected' AND bo.delivered_at IS NULL
              ) = 0
          AND COUNT(*) FILTER (WHERE bo.delivered_at IS NOT NULL) > 0
     ),
     ranked AS (
       SELECT o.id            AS order_id,
              o.customer_id   AS referee,
              d.delivered_at,
              ROW_NUMBER() OVER (
                PARTITION BY o.customer_id
                ORDER BY d.delivered_at, o.created_at
              )               AS order_rank,
              a.address_1, a.address_2, a.city, a.postal_code,
              LOWER(sc.name)  AS channel
         FROM delivered d
         JOIN public."order" o        ON o.id = d.order_id
         LEFT JOIN public.address a   ON a.id = o.shipping_address_id
         LEFT JOIN public.sales_channel sc ON sc.id = o.sales_channel_id
        WHERE o.canceled_at IS NULL
          AND o.customer_id IS NOT NULL
     )
     SELECT r.referred_by_customer_id AS referrer,
            r.brand                   AS referral_brand,
            k.*
       FROM ranked k
       JOIN wallet.referrals r ON r.customer_id = k.referee
      WHERE k.order_rank <= $1
        AND k.delivered_at <= $2
        AND k.delivered_at >= $2::timestamptz - ($3 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM wallet.entries e
           WHERE e.customer_id = r.referred_by_customer_id
             AND e.entry_type  = 'referral_earn'
             AND e.order_id    = k.order_id
        )
      ORDER BY k.delivered_at, k.order_id
      LIMIT $4`,
    [MAX_WINDOW_ORDERS, at, String(LOOKBACK_DAYS), limit]
  )

  return rows.map((r) => ({
    referrerCustomerId: r.referrer,
    refereeCustomerId: r.referee,
    orderId: r.order_id,
    orderRank: Number(r.order_rank),
    deliveredAt: r.delivered_at,
    pincode: r.postal_code ?? null,
    brand: brandOfOrder(r.channel, r.referral_brand),
    /* Stamped so GS-5.3's per-address cap has something to count. See the header. */
    addressHash: addressFingerprint({
      line1: r.address_1,
      line2: r.address_2,
      city: r.city,
      postalCode: r.postal_code,
    }),
  }))
}

/**
 * What one referrer has already earned, and from how many addresses — GS-5.3.
 *
 * ── Why these are counted rather than stored on a column ───────────────────────────────────────
 * A running total is a number that can drift from the entries it claims to summarise, and the moment
 * it does, the cap is either refusing honest referrers or waving through the ring it exists to stop.
 * The ledger is the only record, so the caps are read from it — three indexed counts, on a path that
 * runs nightly rather than per request.
 *
 * ── Why reversals are excluded ─────────────────────────────────────────────────────────────────
 * A reward taken back because the order was refunded never happened, and counting it against a
 * customer's annual cap would punish them for somebody else's cancellation. The same NOT EXISTS the
 * rest of the ledger uses.
 */
async function earningsSoFar(params: {
  referrerCustomerId: string
  brand: Brand
  addressHash: string | null
  at: Date
}): Promise<{ monthPaise: number; yearPaise: number; addressRewards: number }> {
  const { rows } = await getWalletDbPool().query(
    `WITH live AS (
       SELECT e.amount_paise, e.created_at, e.address_hash
         FROM wallet.entries e
        WHERE e.customer_id = $1
          AND e.brand = $2
          AND e.entry_type = 'referral_earn'
          AND NOT EXISTS (
            SELECT 1 FROM wallet.entries r
             WHERE r.entry_type = 'reversal' AND r.source_entry_id = e.id
          )
     )
     SELECT
       COALESCE(SUM(amount_paise) FILTER (
         WHERE created_at >= $3::timestamptz - INTERVAL '30 days'), 0)::bigint AS month_paise,
       COALESCE(SUM(amount_paise) FILTER (
         WHERE created_at >= $3::timestamptz - INTERVAL '365 days'), 0)::bigint AS year_paise,
       COUNT(*) FILTER (
         WHERE $4::text IS NOT NULL AND address_hash = $4)::int AS address_rewards
       FROM live`,
    [params.referrerCustomerId, params.brand, params.at, params.addressHash]
  )

  return {
    monthPaise: Number(rows[0].month_paise),
    yearPaise: Number(rows[0].year_paise),
    addressRewards: rows[0].address_rewards as number,
  }
}

/**
 * What one candidate is worth, and whether it is owed yet.
 *
 * Separated from the writing so the figure can be shown — in a preview, in a test — without a row
 * appearing anywhere, the same division the joining cash engine makes.
 */
export async function evaluatePayout(
  due: DuePayout,
  valuePaise: number | null,
  at: Date = new Date()
): Promise<PayoutDecision> {
  const config = await getEffectiveConfig(due.brand, due.pincode, MECHANIC)

  const windowOrders = Number(config?.params?.window_orders ?? 0)
  const holdDays = Number(config?.params?.hold_days ?? 0)
  const rateBps = Number(config?.params?.rate_bps ?? 0)
  const capPaise = Number(config?.params?.per_order_cap_paise ?? 0)

  if (!windowOrders || due.orderRank > windowOrders) {
    return {
      owed: false,
      reason: "outside_window",
      explanation:
        `This was order ${due.orderRank} for the customer, and only the first ` +
        `${windowOrders || 0} earn the referrer anything.`,
    }
  }

  const dueAt = new Date(due.deliveredAt.getTime() + holdDays * 86_400_000)
  if (dueAt > at) {
    return {
      owed: false,
      reason: "still_on_hold",
      explanation:
        `Delivered ${due.deliveredAt.toISOString().slice(0, 10)}; the ${holdDays}-day return ` +
        `window closes ${dueAt.toISOString().slice(0, 10)}.`,
    }
  }

  /**
   * The switch, the budget and the grant cap — the same evaluator every mechanic goes through.
   *
   * Checked after the window and the hold on purpose: those two are properties of the order and
   * cannot change, so an order that fails them should never have consumed a budget check. It is
   * checked before the value is read because reading the value costs a round trip into Medusa, and
   * there is no sense pricing a reward that is switched off.
   */
  const verdict = await evaluateMechanic({
    brand: due.brand,
    pincode: due.pincode,
    mechanic: MECHANIC,
    at,
    /* The order was delivered; the readiness bar is asking a question that has been answered. The
       switch, the budget, the end date and the grant cap all still apply — see the option's own
       documentation for why this is not honouringPromise. */
    supplyAlreadyProven: true,
  })

  if (!verdict.allowed || !verdict.config) {
    return {
      owed: false,
      reason: "mechanic_unavailable",
      explanation: verdict.explanation ?? "Referral is not running here.",
    }
  }

  if (valuePaise === null || !Number.isFinite(valuePaise) || valuePaise <= 0) {
    return {
      owed: false,
      reason: "no_order_value",
      explanation: "Could not read what this order was worth, so nothing is paid on it.",
    }
  }

  /* Floored, not rounded: a commission should never come out above the rate it advertises, and a
     rate that sometimes pays a paise more than it says is a rate nobody can reconcile. */
  const earned = Math.floor((valuePaise * rateBps) / 10_000)
  const amountPaise = Math.min(earned, capPaise)

  if (amountPaise <= 0) {
    return {
      owed: false,
      reason: "rounds_to_nothing",
      explanation: `${rateBps} bps of ₹${(valuePaise / 100).toFixed(2)} is less than a paise.`,
    }
  }

  /**
   * The caps that bound a person rather than an offer — GS-5.3.
   *
   * ── Why they are checked last ────────────────────────────────────────────────────────────────
   * They need the amount, because "would this take them over ₹1,000 this year" is a question about
   * the payment being considered and not about the customer in general. Checking earlier would mean
   * either refusing somebody who is under the cap or computing the amount twice.
   *
   * ── Why a reward that would breach a cap is refused outright, not trimmed ────────────────────
   * Paying ₹18 of a ₹40 reward because that is what is left under the annual cap produces a figure
   * no referrer can reconcile against the rate they were told, and an explanation nobody wants to
   * write. The cap is a limit on how many rewards somebody can earn, not a haircut on each one.
   */
  const addressCap = config?.params?.max_per_address
  const monthlyCap = config?.params?.monthly_cap_paise
  const annualCap = config?.params?.annual_cap_paise

  if (addressCap != null || monthlyCap != null || annualCap != null) {
    const earned = await earningsSoFar({
      referrerCustomerId: due.referrerCustomerId,
      brand: due.brand,
      addressHash: due.addressHash,
      at,
    })

    if (addressCap != null && due.addressHash && earned.addressRewards >= Number(addressCap)) {
      return {
        owed: false,
        reason: "address_cap_reached",
        explanation:
          `This referrer has already earned ${earned.addressRewards} reward(s) from deliveries to ` +
          `this address, and the limit is ${addressCap}.`,
      }
    }

    if (monthlyCap != null && earned.monthPaise + amountPaise > Number(monthlyCap)) {
      return {
        owed: false,
        reason: "monthly_cap_reached",
        explanation:
          `₹${(earned.monthPaise / 100).toFixed(2)} earned in the last 30 days; another ` +
          `₹${(amountPaise / 100).toFixed(2)} would pass the ₹${(Number(monthlyCap) / 100).toFixed(2)} monthly limit.`,
      }
    }

    if (annualCap != null && earned.yearPaise + amountPaise > Number(annualCap)) {
      return {
        owed: false,
        reason: "annual_cap_reached",
        explanation:
          `₹${(earned.yearPaise / 100).toFixed(2)} earned in the last year; another ` +
          `₹${(amountPaise / 100).toFixed(2)} would pass the ₹${(Number(annualCap) / 100).toFixed(2)} annual limit.`,
      }
    }
  }

  return { owed: true, amountPaise, valuePaise, configVersion: verdict.config.version }
}

/**
 * Pays one candidate.
 *
 * ── Why a second payment cannot happen ─────────────────────────────────────────────────────────
 * Not because this checked first — it does check, and the check is a race. The unique index on
 * (customer_id, entry_type, order_id) is what makes it true: a second insert for the same referrer
 * and order does nothing and returns no row, whether it arrives a millisecond or a month later, from
 * this job or from a backfill somebody runs by hand.
 */
export async function payReferral(
  due: DuePayout,
  valuePaise: number | null,
  at: Date = new Date()
): Promise<PayoutOutcome> {
  const decision = await evaluatePayout(due, valuePaise, at)
  if (isNotOwed(decision)) {
    return { paid: false, reason: decision.reason, explanation: decision.explanation }
  }

  const entry = await grantCredit({
    customerId: due.referrerCustomerId,
    entryType: "referral_earn",
    amountPaise: decision.amountPaise,
    brand: due.brand,
    pincode: due.pincode,
    orderId: due.orderId,
    configVersion: decision.configVersion,
    addressHash: due.addressHash,
  })

  if (!entry) {
    return {
      paid: false,
      reason: "already_paid",
      explanation: "A referral reward for this order already exists.",
    }
  }

  return {
    paid: true,
    entryId: entry.id,
    amountPaise: decision.amountPaise,
    valuePaise: decision.valuePaise,
  }
}

export interface SweepResult {
  considered: number
  paid: number
  paidPaise: number
  /** Counted by reason, so a night where nothing paid still says why. */
  skipped: Record<string, number>
  failures: number
}

/**
 * One pass over everything that has come due.
 *
 * ── Why one failure does not stop the sweep ────────────────────────────────────────────────────
 * A single unreadable order, a referrer whose account has gone, a configuration somebody saved
 * halfway — any of these can throw for one candidate, and letting it end the run would mean one bad
 * row holding up every other payout indefinitely. Each is counted and the sweep continues; a
 * candidate that failed is still a candidate tomorrow, because nothing about it has been written.
 */
export async function sweepReferralPayouts(params: {
  resolveOrderValue: OrderValueResolver
  at?: Date
  limit?: number
}): Promise<SweepResult> {
  const at = params.at ?? new Date()
  const due = await findDuePayouts({ at, limit: params.limit })

  const result: SweepResult = {
    considered: due.length,
    paid: 0,
    paidPaise: 0,
    skipped: {},
    failures: 0,
  }

  for (const candidate of due) {
    try {
      /* The value is read per candidate rather than in one batch, because most candidates are
         refused by the window or the hold before the value is ever needed and batching would fetch
         an order total for every one of them. */
      const value = await params.resolveOrderValue(candidate.orderId)
      const outcome = await payReferral(candidate, value, at)

      if (isUnpaid(outcome)) {
        result.skipped[outcome.reason] = (result.skipped[outcome.reason] ?? 0) + 1
      } else {
        result.paid += 1
        result.paidPaise += outcome.amountPaise
      }
    } catch (error) {
      result.failures += 1
      console.error(
        `[wallet] referral payout failed for order ${candidate.orderId}: ` +
          `${error instanceof Error ? error.message : error}`
      )
    }
  }

  return result
}
