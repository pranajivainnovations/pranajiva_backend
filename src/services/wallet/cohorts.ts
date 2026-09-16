import { getWalletDbPool } from "./db"
import type { Brand } from "./ledger"

/**
 * Did the offer work?
 *
 * ── Why this exists before the offer does ──────────────────────────────────────────────────────
 * The plan is a bet on 90-day repeat rate — at 30% it works, at 15% it does not — and a repeat rate
 * measured only after an offer launches has nothing to be compared against. The number that matters
 * is the difference between customers who got joining cash and customers who did not, in the same
 * pincode, over the same period. Running this now establishes the "before", which cannot be
 * reconstructed later from anything.
 *
 * ── The two cohorts ────────────────────────────────────────────────────────────────────────────
 * Treated: placed a first order and received joining cash on it. Untreated: placed a first order and
 * did not — because the offer had not started, had run out of budget, or was not running in their
 * pincode. Comparing them is as close to a controlled comparison as a live business gets, and it is
 * far more honest than watching repeat rate rise and attributing it to the offer.
 *
 * ── What cannot be measured, and why it is said rather than approximated ───────────────────────
 * Activation as the spec defines it — signups who go on to order — needs a pincode for people who
 * never ordered, and nothing records one. A customer's pincode is learned from their first order's
 * delivery address, so every customer with a pincode has ordered by definition and the per-pincode
 * figure would be 100% every time. That is not a hard number to produce and it would be a lie.
 * Brand-wide activation is computable and is reported instead.
 */

export interface CohortRepeat {
  /** Customers whose first order is old enough for the window to have closed. */
  eligible: number
  /** Of those, how many ordered again inside the window. */
  repeated: number
  /** Null rather than zero when nobody is eligible yet — no data is not a 0% repeat rate. */
  ratePct: number | null
}

export interface RepeatReport {
  brand: Brand
  pincode: string | null
  windowDays: number
  treated: CohortRepeat
  untreated: CohortRepeat
  /** treated − untreated, in percentage points. Null until both cohorts have members. */
  liftPct: number | null
  generatedAt: Date
}

const rate = (repeated: number, eligible: number): number | null =>
  eligible === 0 ? null : Math.round((repeated / eligible) * 1000) / 10

/**
 * Repeat rate for both cohorts, in one pass.
 *
 * ── Why the window closes before a customer counts ─────────────────────────────────────────────
 * A customer whose first order was yesterday has not failed to repeat; they have not had the chance.
 * Counting them in the denominator makes every freshly launched pincode look like a disaster, and
 * makes the number fall every time the offer succeeds at bringing new people in. Only first orders
 * older than the window are eligible.
 */
export async function getRepeatRate(params: {
  brand: Brand
  pincode: string | null
  windowDays?: number
  at?: Date
}): Promise<RepeatReport> {
  const windowDays = params.windowDays ?? 90
  const at = params.at ?? new Date()

  const { rows } = await getWalletDbPool().query(
    `WITH first_orders AS (
       SELECT o.customer_id,
              MIN(o.created_at) AS first_at,
              /* A customer's pincode is where their first order went. */
              (ARRAY_AGG(a.postal_code ORDER BY o.created_at))[1] AS pincode
         FROM public."order" o
         LEFT JOIN public.address a ON a.id = o.shipping_address_id
        WHERE o.customer_id IS NOT NULL
        GROUP BY o.customer_id
     ),
     eligible AS (
       SELECT f.customer_id, f.first_at, f.pincode,
              /* Treated means joining cash actually landed on that first order's customer. */
              EXISTS (
                SELECT 1 FROM wallet.entries e
                 WHERE e.customer_id = f.customer_id
                   AND e.brand = $1
                   AND e.entry_type = 'promo_grant'
              ) AS treated
         FROM first_orders f
        WHERE f.first_at <= $2::timestamptz - ($3 || ' days')::interval
          AND ($4::text IS NULL OR f.pincode = $4)
     )
     SELECT e.treated,
            COUNT(*)::int AS eligible,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM public."order" o2
                 WHERE o2.customer_id = e.customer_id
                   AND o2.created_at > e.first_at
                   AND o2.created_at <= e.first_at + ($3 || ' days')::interval
              )
            )::int AS repeated
       FROM eligible e
      GROUP BY e.treated`,
    [params.brand, at, String(windowDays), params.pincode]
  )

  const pick = (treated: boolean): CohortRepeat => {
    const row = rows.find((r) => r.treated === treated)
    const eligible = row?.eligible ?? 0
    const repeated = row?.repeated ?? 0
    return { eligible, repeated, ratePct: rate(repeated, eligible) }
  }

  const treated = pick(true)
  const untreated = pick(false)

  return {
    brand: params.brand,
    pincode: params.pincode,
    windowDays,
    treated,
    untreated,
    liftPct:
      treated.ratePct === null || untreated.ratePct === null
        ? null
        : Math.round((treated.ratePct - untreated.ratePct) * 10) / 10,
    generatedAt: at,
  }
}

export interface ActivationReport {
  /** Registered customers whose account is old enough for the window to have closed. */
  eligible: number
  /** Of those, how many ever placed an order. */
  ordered: number
  ratePct: number | null
  windowDays: number
  /**
   * Why this is not broken down by pincode.
   *
   * Carried in the response rather than left to each screen to remember, so the limitation travels
   * with the number instead of being explained once in a document nobody reads twice.
   */
  note: string
}

/**
 * Brand-wide activation: of the people who signed up, how many bought anything.
 *
 * Deliberately not scoped to a pincode — see the note at the top of this file. The figure is still
 * worth having: it is the denominator of the whole model, and a launch that doubles orders while
 * activation falls is a launch that bought the same customers twice.
 */
export async function getActivation(params: {
  windowDays?: number
  at?: Date
}): Promise<ActivationReport> {
  const windowDays = params.windowDays ?? 30
  const at = params.at ?? new Date()

  const { rows } = await getWalletDbPool().query(
    `WITH eligible AS (
       SELECT c.id
         FROM public.customer c
        WHERE c.has_account = true
          AND c.deleted_at IS NULL
          AND c.created_at <= $1::timestamptz - ($2 || ' days')::interval
     )
     SELECT COUNT(*)::int AS eligible,
            COUNT(*) FILTER (
              WHERE EXISTS (SELECT 1 FROM public."order" o WHERE o.customer_id = eligible.id)
            )::int AS ordered
       FROM eligible`,
    [at, String(windowDays)]
  )

  const eligible = rows[0].eligible as number
  const ordered = rows[0].ordered as number

  return {
    eligible,
    ordered,
    ratePct: rate(ordered, eligible),
    windowDays,
    note:
      "Brand-wide, not per pincode. A customer's pincode is learned from their first order, so " +
      "everyone with a pincode has ordered and a per-pincode figure would always read 100%. " +
      "Recording a pincode at sign-up is what would make it measurable locally.",
  }
}
