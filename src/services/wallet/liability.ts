import { getWalletDbPool } from "./db"
import type { Brand, EntryType } from "./ledger"

/**
 * What the business currently owes its customers, and what it has paid out over time.
 *
 * ── Why this is not just "add up the balances" ─────────────────────────────────────────────────
 * It is the same arithmetic, but the question is different and so is the shape of the answer. A
 * customer wants one number. The business needs to know which of that number is promotional credit
 * it gave away versus rewards people earned, which brand issued it, and — the part that decides
 * whether the figure matters this month or next quarter — when it expires. A single total hides all
 * three, and the three are what a decision is made on.
 *
 * ── Why expired-but-unswept is its own bucket ──────────────────────────────────────────────────
 * Credit past its date is not owed: nobody can spend it. But until the nightly sweep writes it off,
 * the plain sum of the ledger still contains it. Reporting it as a separate line rather than
 * silently dropping it means the total here can be reconciled against the ledger, and it doubles as
 * the measure of whether the sweep is running — a bucket that grows for days is a job that stopped.
 */

export type ExpiryBucket =
  | "awaiting_sweep"
  | "within_7_days"
  | "within_30_days"
  | "within_90_days"
  | "later"
  | "never"

export interface LiabilityRow {
  brand: Brand
  entryType: EntryType
  bucket: ExpiryBucket
  paise: number
  grants: number
  customers: number
}

export interface MovementRow {
  brand: Brand
  entryType: EntryType
  paise: number
  count: number
}

export interface LiabilityReport {
  /** Credit that can be spent right now. This is the number the business is exposed to. */
  outstandingPaise: number
  /** Past its date, not yet written off. Not owed — see the note above. */
  awaitingSweepPaise: number
  /** Clawed back with nothing left to take it from; reduces what is owed. */
  debtPaise: number
  byBucket: LiabilityRow[]
  /** Lifetime totals per type, so issued and redeemed can be compared. */
  movements: MovementRow[]
  generatedAt: Date
}

const LIVE_ALLOCATIONS = `
  SELECT a.grant_entry_id, SUM(a.amount_paise)::bigint AS taken
    FROM wallet.allocations a
    JOIN wallet.entries c ON c.id = a.consuming_entry_id
   WHERE NOT EXISTS (
     SELECT 1 FROM wallet.entries r
      WHERE r.entry_type = 'reversal' AND r.source_entry_id = c.id
   )
   GROUP BY a.grant_entry_id
`

function toPaise(value: string | number | null): number {
  if (value === null) return 0
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(n)) throw new Error(`[wallet] liability amount ${value} is out of range`)
  return n
}

export async function getLiabilityReport(): Promise<LiabilityReport> {
  const db = getWalletDbPool()

  /**
   * Buckets are cut in SQL rather than in JavaScript.
   *
   * Not for speed at today's volumes — there are no rows yet — but because the alternative is
   * shipping every unspent grant to the application to be counted, which is a query that works
   * beautifully in testing and falls over the first month it matters. The boundaries are inclusive
   * upward: a grant expiring in exactly seven days is in the seven-day bucket, not the thirty.
   */
  const buckets = db.query(
    `WITH consumed AS (${LIVE_ALLOCATIONS})
     SELECT e.brand,
            e.entry_type,
            CASE
              WHEN e.expires_at IS NULL                             THEN 'never'
              WHEN e.expires_at <= NOW()                            THEN 'awaiting_sweep'
              WHEN e.expires_at <= NOW() + INTERVAL '7 days'        THEN 'within_7_days'
              WHEN e.expires_at <= NOW() + INTERVAL '30 days'       THEN 'within_30_days'
              WHEN e.expires_at <= NOW() + INTERVAL '90 days'       THEN 'within_90_days'
              ELSE 'later'
            END AS bucket,
            SUM(e.amount_paise - COALESCE(c.taken, 0))::bigint AS paise,
            COUNT(*)::int AS grants,
            COUNT(DISTINCT e.customer_id)::int AS customers
       FROM wallet.entries e
       LEFT JOIN consumed c ON c.grant_entry_id = e.id
      WHERE e.entry_type IN ('promo_grant', 'referral_earn', 'cashback_earn', 'manual_grant')
        AND (e.amount_paise - COALESCE(c.taken, 0)) > 0
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`
  )

  /**
   * Lifetime movements, signed, so issued and redeemed sit side by side.
   *
   * Grants come out positive and redemptions, expiries and clawbacks negative, which is what makes
   * "we issued ₹80,000 and ₹31,000 of it has actually been spent" a subtraction rather than a
   * separate query with its own chance of disagreeing.
   */
  const movements = db.query(
    `SELECT brand, entry_type,
            SUM(amount_paise)::bigint AS paise,
            COUNT(*)::int AS count
       FROM wallet.entries
      GROUP BY 1, 2
      ORDER BY 1, 2`
  )

  /** Unrecovered clawbacks, which reduce what is owed rather than adding to it. */
  const debt = db.query(
    `SELECT COALESCE(SUM(ABS(e.amount_paise) - COALESCE(a.allocated, 0)), 0)::bigint AS debt
       FROM wallet.entries e
       LEFT JOIN (
         SELECT consuming_entry_id, SUM(amount_paise)::bigint AS allocated
           FROM wallet.allocations GROUP BY consuming_entry_id
       ) a ON a.consuming_entry_id = e.id
      WHERE e.amount_paise < 0
        AND ABS(e.amount_paise) > COALESCE(a.allocated, 0)`
  )

  const [bucketRes, movementRes, debtRes] = await Promise.all([buckets, movements, debt])

  const byBucket: LiabilityRow[] = bucketRes.rows.map((r) => ({
    brand: r.brand,
    entryType: r.entry_type,
    bucket: r.bucket,
    paise: toPaise(r.paise),
    grants: r.grants,
    customers: r.customers,
  }))

  const debtPaise = toPaise(debtRes.rows[0].debt)
  const awaitingSweepPaise = byBucket
    .filter((r) => r.bucket === "awaiting_sweep")
    .reduce((sum, r) => sum + r.paise, 0)

  return {
    /* Everything except what has already expired, less what is owed back to us. This is the figure
       that answers "if every customer spent everything tomorrow, what would it cost us". */
    outstandingPaise:
      byBucket.reduce((sum, r) => sum + r.paise, 0) - awaitingSweepPaise - debtPaise,
    awaitingSweepPaise,
    debtPaise,
    byBucket,
    movements: movementRes.rows.map((r) => ({
      brand: r.brand,
      entryType: r.entry_type,
      paise: toPaise(r.paise),
      count: r.count,
    })),
    generatedAt: new Date(),
  }
}
