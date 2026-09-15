import type { PoolClient } from "pg"

import { getWalletDbPool } from "./db"

/**
 * Reading and spending the wallet.
 *
 * The ledger stores what happened; this module answers the two questions anything else ever asks of
 * it — how much can this customer spend, and which credit does spending it consume.
 *
 * ── Why a balance is never stored ──────────────────────────────────────────────────────────────
 * It is derived here, every time. A stored balance is a number that must survive every concurrent
 * write correctly and, when it does not, cannot be checked against anything. Deriving it costs one
 * indexed query and is right by construction.
 *
 * ── How a grant's remaining value is known without ever updating it ────────────────────────────
 * A grant row never changes. What it has left is its amount minus everything allocated away from
 * it, and `wallet.allocations` records each of those movements against the specific grant it took
 * from. That is what makes expiry answerable: when promo credit expiring Friday sits beside
 * referral credit and the customer spends once, the sweeper can see which of the two is gone.
 *
 * ── How reversal fits, without a second mechanism ──────────────────────────────────────────────
 * Allocations belonging to a reversed movement stop counting. So reversing a redemption restores
 * exactly the lots it took, with their original expiry dates intact — no credit is re-minted with a
 * fresh clock, which is what copying the amount into a new grant would have done. A reversal in the
 * other direction, clawing back a grant, allocates against that grant like any other consumer. One
 * rule covers both, and both keep the arithmetic below agreeing with the sum of the ledger.
 */

/** Grants only. Movements consume these; they are never consumed themselves. */
const GRANT_TYPES = ["promo_grant", "referral_earn", "cashback_earn", "manual_grant"] as const

/**
 * Credit we gave away, as opposed to credit the customer did something to earn.
 *
 * Spent first, so earned credit survives longest. A manual goodwill grant counts as given: it cost
 * the customer nothing, and it is the kind most likely to have been issued to smooth over a problem
 * rather than to be banked.
 */
const GIVEN_TYPES = ["promo_grant", "manual_grant"] as const

export type EntryType =
  | (typeof GRANT_TYPES)[number]
  | "redemption"
  | "reversal"
  | "expiry"

export type Brand = "crossfriend" | "pranajiva"

export interface Lot {
  id: string
  entryType: (typeof GRANT_TYPES)[number]
  brand: Brand
  /** What the grant was worth when issued. */
  amountPaise: number
  /** What is left of it now. Always positive — exhausted lots are not returned. */
  remainingPaise: number
  expiresAt: Date | null
}

export interface Allocation {
  lotId: string
  amountPaise: number
}

export interface RedemptionPlan {
  /** What can actually be taken, which may be less than what was asked for. */
  totalPaise: number
  /** Shortfall against the request, so a caller can tell "spent less" from "spent nothing". */
  shortfallPaise: number
  allocations: Allocation[]
}

/**
 * Money is BIGINT in Postgres and arrives as a string, because a bigint does not always fit a JS
 * number. Paise balances are nowhere near 2^53 — that is ninety trillion rupees — so the conversion
 * is safe, but it has to be deliberate: left as strings, `a + b` silently concatenates.
 */
function paise(value: string | number | null): number {
  if (value === null) return 0
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(n)) {
    throw new Error(`[wallet] amount ${value} is not a safe integer`)
  }
  return n
}

/**
 * The spend order, in one place because it is policy rather than plumbing.
 *
 *   1. Expiring soonest, never-expiring last. Strictly best for the customer: credit about to
 *      vanish is used while it still has value, rather than being lost with credit left over.
 *   2. Given before earned, when expiry does not separate them.
 *   3. Oldest first, so the order is total and two runs of the same plan agree.
 */
const SPEND_ORDER = `
  ORDER BY e.expires_at ASC NULLS LAST,
           (e.entry_type = ANY($2)) DESC,
           e.created_at ASC,
           e.id ASC
`

/**
 * Allocations that still count.
 *
 * A movement whose reversal exists is treated as never having happened, which is what restores the
 * lots it consumed. Written as NOT EXISTS rather than a LEFT JOIN so a movement reversed twice —
 * which should not happen, but is not prevented by the schema — still subtracts exactly once.
 */
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

/**
 * The customer's spendable lots, in the order they should be spent.
 *
 * Excludes what has expired, so this is "what can be used now" rather than "what exists" — an
 * expired grant the sweeper has not yet written an entry for must not be spendable in the meantime,
 * and the sweeper running late must never be the difference between a discount applying or not.
 */
export async function getLots(customerId: string, client?: PoolClient): Promise<Lot[]> {
  const db = client ?? getWalletDbPool()

  const { rows } = await db.query(
    `WITH consumed AS (${LIVE_ALLOCATIONS})
     SELECT e.id, e.entry_type, e.brand, e.amount_paise, e.expires_at,
            (e.amount_paise - COALESCE(c.taken, 0))::bigint AS remaining_paise
       FROM wallet.entries e
       LEFT JOIN consumed c ON c.grant_entry_id = e.id
      WHERE e.customer_id = $1
        AND e.entry_type = ANY($3)
        AND (e.expires_at IS NULL OR e.expires_at > NOW())
        AND (e.amount_paise - COALESCE(c.taken, 0)) > 0
     ${SPEND_ORDER}`,
    [customerId, GIVEN_TYPES, GRANT_TYPES]
  )

  return rows.map((r) => ({
    id: r.id,
    entryType: r.entry_type,
    brand: r.brand,
    amountPaise: paise(r.amount_paise),
    remainingPaise: paise(r.remaining_paise),
    expiresAt: r.expires_at,
  }))
}

/**
 * Credit taken back that there was nothing left to take it from.
 *
 * A movement normally allocates its whole magnitude against specific lots. One case cannot: an
 * order refunded after its reward was already spent, under the `allow_negative` clawback policy,
 * reverses the full grant while only part of it — often none — still exists to reclaim. The
 * unallocated remainder is a debt, and it is simply the difference between what the entry says it
 * took and what it managed to allocate.
 *
 * Under the default `write_off` policy this is always zero, because a reversal there only ever
 * claims what is actually there. The term costs one indexed query and makes the other policy work
 * rather than merely be described.
 */
export async function getDebt(customerId: string, client?: PoolClient): Promise<number> {
  const db = client ?? getWalletDbPool()

  const { rows } = await db.query(
    `SELECT COALESCE(SUM(ABS(e.amount_paise) - COALESCE(a.allocated, 0)), 0)::bigint AS debt
       FROM wallet.entries e
       LEFT JOIN (
         SELECT consuming_entry_id, SUM(amount_paise)::bigint AS allocated
           FROM wallet.allocations GROUP BY consuming_entry_id
       ) a ON a.consuming_entry_id = e.id
      WHERE e.customer_id = $1
        AND e.amount_paise < 0
        AND ABS(e.amount_paise) > COALESCE(a.allocated, 0)`,
    [customerId]
  )

  return paise(rows[0].debt)
}

/**
 * What the customer can spend right now, across both brands.
 *
 * Signed, not floored at zero: if a clawback has left them owing, the wallet must say so rather
 * than showing a reassuring ₹0 while quietly swallowing the next credit they earn.
 */
export async function getBalance(customerId: string, client?: PoolClient): Promise<number> {
  const [lots, debt] = await Promise.all([getLots(customerId, client), getDebt(customerId, client)])
  return lots.reduce((sum, lot) => sum + lot.remainingPaise, 0) - debt
}

/**
 * Which lots an amount would consume, without writing anything.
 *
 * Exists separately from {@link redeem} because checkout needs to show what a discount will cost
 * before anyone commits to it, and because a plan is the thing worth asserting about in a test.
 * Takes less than asked when the balance is short rather than failing: a customer with ₹80 applying
 * credit to an order wants ₹80 off, not an error.
 */
export function planFromLots(lots: Lot[], requestedPaise: number): RedemptionPlan {
  if (!Number.isSafeInteger(requestedPaise) || requestedPaise <= 0) {
    throw new Error(`[wallet] cannot redeem ${requestedPaise}`)
  }

  const allocations: Allocation[] = []
  let remaining = requestedPaise

  for (const lot of lots) {
    if (remaining <= 0) break
    const take = Math.min(lot.remainingPaise, remaining)
    if (take <= 0) continue
    allocations.push({ lotId: lot.id, amountPaise: take })
    remaining -= take
  }

  return {
    totalPaise: requestedPaise - remaining,
    shortfallPaise: remaining,
    allocations,
  }
}

/**
 * Caps a request at what the customer actually has, net of any debt.
 *
 * Lots and debt are separate quantities: someone can hold an untouched ₹100 grant and owe ₹40 from
 * a refunded reward, and planning against the lots alone would let them spend ₹100. Netting first is
 * what makes the debt real rather than decorative.
 */
function ceilingFor(lots: Lot[], debt: number, requestedPaise: number): number {
  const spendable = lots.reduce((sum, lot) => sum + lot.remainingPaise, 0) - debt
  return Math.min(requestedPaise, Math.max(0, spendable))
}

export async function planRedemption(
  customerId: string,
  requestedPaise: number,
  client?: PoolClient
): Promise<RedemptionPlan> {
  const [lots, debt] = await Promise.all([getLots(customerId, client), getDebt(customerId, client)])
  const capped = ceilingFor(lots, debt, requestedPaise)
  if (capped <= 0) return { totalPaise: 0, shortfallPaise: requestedPaise, allocations: [] }
  const plan = planFromLots(lots, capped)
  return { ...plan, shortfallPaise: requestedPaise - plan.totalPaise }
}

export interface RedeemResult {
  entryId: string
  redeemedPaise: number
  shortfallPaise: number
  allocations: Allocation[]
}

/**
 * Spend credit: one redemption entry, plus the allocations saying what it took.
 *
 * ── Why the lots are locked ────────────────────────────────────────────────────────────────────
 * Planning and writing are two steps, and between them another request can spend the same lot — a
 * customer with one tab per device, or a checkout retried on a slow response. Both would plan
 * against the same remaining value and both would write, overdrawing the wallet with no constraint
 * to stop them, because "remaining" is derived rather than a column something can fight over.
 *
 * So the transaction takes a row lock on the customer's grants first and plans inside it. The
 * second request waits, re-reads, and sees what the first actually spent. SELECT ... FOR UPDATE is
 * a lock, not a write, so the append-only trigger is untouched.
 *
 * `brand` is the brand the credit is being SPENT on, which is deliberately allowed to differ from
 * the brand that issued each lot — that is the cross-brand wallet working as intended. The report
 * that says which brand funded whose growth reads the issuing brand off the lots.
 */
export async function redeem(params: {
  customerId: string
  requestedPaise: number
  brand: Brand
  orderId: string
  configVersion?: number | null
}): Promise<RedeemResult> {
  const pool = getWalletDbPool()
  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    /* Locks this customer's grant rows for the transaction. Ordered so that two transactions
       locking the same customer take the rows in the same sequence and cannot deadlock. */
    await client.query(
      `SELECT id FROM wallet.entries
        WHERE customer_id = $1 AND entry_type = ANY($2)
        ORDER BY id
        FOR UPDATE`,
      [params.customerId, GRANT_TYPES]
    )

    const lots = await getLots(params.customerId, client)
    const debt = await getDebt(params.customerId, client)
    const capped = ceilingFor(lots, debt, params.requestedPaise)
    const plan =
      capped > 0
        ? { ...planFromLots(lots, capped) }
        : { totalPaise: 0, shortfallPaise: params.requestedPaise, allocations: [] }
    plan.shortfallPaise = params.requestedPaise - plan.totalPaise

    if (plan.totalPaise <= 0) {
      await client.query("ROLLBACK")
      throw new Error("[wallet] no credit available to redeem")
    }

    const { rows } = await client.query(
      `INSERT INTO wallet.entries
         (customer_id, entry_type, amount_paise, brand, config_version, order_id)
       VALUES ($1, 'redemption', $2, $3, $4, $5)
       RETURNING id`,
      [params.customerId, -plan.totalPaise, params.brand, params.configVersion ?? null, params.orderId]
    )
    const entryId: string = rows[0].id

    /* One statement rather than a loop: a partial set of allocations would leave a redemption that
       took more than it recorded, and the difference is credit the customer keeps and we do not. */
    await client.query(
      `INSERT INTO wallet.allocations (consuming_entry_id, grant_entry_id, amount_paise)
       SELECT $1, lot_id, amount FROM UNNEST($2::uuid[], $3::bigint[]) AS t(lot_id, amount)`,
      [entryId, plan.allocations.map((a) => a.lotId), plan.allocations.map((a) => a.amountPaise)]
    )

    await client.query("COMMIT")

    return {
      entryId,
      redeemedPaise: plan.totalPaise,
      shortfallPaise: plan.shortfallPaise,
      allocations: plan.allocations,
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * Cross-check: the derived balance against the plain sum of the ledger.
 *
 * Two independent routes to the same number. The sum knows nothing about allocations; the balance
 * knows nothing about entry signs. They agree only if every movement allocated exactly what it
 * claimed, so a disagreement is a real defect in whatever wrote the last entry — and one that would
 * otherwise surface as a customer quietly holding the wrong amount.
 *
 * They part company on exactly one thing, which is not an error: a grant that has expired but whose
 * `expiry` entry the sweeper has not written yet is excluded from the balance and still counted in
 * the sum. That difference is returned rather than hidden, because it is also the measure of how far
 * behind the sweeper is.
 */
export async function reconcile(customerId: string): Promise<{
  balancePaise: number
  ledgerSumPaise: number
  pendingExpiryPaise: number
  agrees: boolean
}> {
  const db = getWalletDbPool()

  const [balancePaise, sumRow, pendingRow] = await Promise.all([
    getBalance(customerId),
    db
      .query(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
           FROM wallet.entries WHERE customer_id = $1`,
        [customerId]
      )
      .then((r) => paise(r.rows[0].total)),
    db
      .query(
        `WITH consumed AS (${LIVE_ALLOCATIONS})
         SELECT COALESCE(SUM(e.amount_paise - COALESCE(c.taken, 0)), 0)::bigint AS total
           FROM wallet.entries e
           LEFT JOIN consumed c ON c.grant_entry_id = e.id
          WHERE e.customer_id = $1
            AND e.entry_type = ANY($2)
            AND e.expires_at IS NOT NULL
            AND e.expires_at <= NOW()
            AND (e.amount_paise - COALESCE(c.taken, 0)) > 0`,
        [customerId, GRANT_TYPES]
      )
      .then((r) => paise(r.rows[0].total)),
  ])

  return {
    balancePaise,
    ledgerSumPaise: sumRow,
    pendingExpiryPaise: pendingRow,
    agrees: balancePaise + pendingRow === sumRow,
  }
}

export interface HistoryEntry {
  id: string
  entryType: EntryType
  amountPaise: number
  createdAt: Date
  expiresAt: Date | null
}

/**
 * What the customer sees of their own ledger.
 *
 * ── What is deliberately not here ──────────────────────────────────────────────────────────────
 * Neither `brand` nor `order_id`. The wallet is one balance shared across two storefronts, so a
 * history row carrying either would let the wellness site show a line traceable to a cake order, and
 * the cake site the reverse. That is the one cross-brand rule with nothing to weigh it against: the
 * balance is shared on purpose, the history is not.
 *
 * Leaving the columns out entirely, rather than filtering them per brand, means there is no
 * parameter a caller can get wrong and no branch that can be inverted by a later edit. Showing
 * "redeemed on order #1412" for same-brand rows is a genuine nicety and belongs with the rest of the
 * cross-brand work, where the requesting brand is established rather than asserted by the caller.
 */
export async function getHistory(
  customerId: string,
  limit = 50
): Promise<HistoryEntry[]> {
  /**
   * Clamped here rather than at the caller, because the caller is an HTTP route and `?limit=abc`
   * is a thing anyone can type. Math.max(1, NaN) is NaN and Math.min(NaN, 200) is NaN, so a clamp
   * alone passes the nonsense straight through to Postgres, which rejects the bind and turns a
   * junk query string into a 500. The finite check is what makes the clamp mean anything.
   */
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 200) : 50

  const { rows } = await getWalletDbPool().query(
    `SELECT id, entry_type, amount_paise, created_at, expires_at
       FROM wallet.entries
      WHERE customer_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [customerId, safeLimit]
  )

  return rows.map((r) => ({
    id: r.id,
    entryType: r.entry_type,
    amountPaise: paise(r.amount_paise),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }))
}
