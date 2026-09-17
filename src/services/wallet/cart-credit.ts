import { getWalletDbPool } from "./db"
import { getBalance, redeem, type Brand } from "./ledger"
import { getEffectiveConfig } from "./reward-config"

/**
 * Spending credit at checkout — the ledger half.
 *
 * ── Why the wallet moves when the customer clicks, not when the order appears ──────────────────
 * Applying credit drops what the customer is charged immediately. If the debit waited for the order,
 * there would be a window — a few seconds, or as long as they take to enter a card — in which the
 * balance could fall from somewhere else: a second tab, an expiry, a refund clawback. The debit would
 * then apply less than the discount already given, and nothing would notice. Debiting first means the
 * worst case is a customer told their credit is no longer available, before they have paid anything.
 *
 * ── Why a cart that is abandoned does not swallow the credit ───────────────────────────────────
 * It would, if nothing undid it. Removing the credit reverses it immediately, and the sweeper
 * reverses what is left on carts that were abandoned — see releaseStaleCartCredit.
 *
 * ── What is deliberately not here ──────────────────────────────────────────────────────────────
 * Gift cards, carts, and anything else Medusa owns. This module moves credit and nothing else, like
 * every other service in this directory; the route above it is the only place that knows the two
 * halves have to agree.
 */

export interface CartCredit {
  entryId: string
  amountPaise: number
}

/**
 * What this cart has already taken from the wallet, if anything.
 *
 * Reversed redemptions do not count — a customer who removed their credit and is looking at the page
 * again has spent nothing. Written as a NOT EXISTS against reversals rather than a status column,
 * because the ledger has no status columns: what happened to an entry is told by the entries that
 * point at it.
 */
export async function getCartCredit(
  cartId: string,
  client?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }
): Promise<CartCredit | null> {
  const db = client ?? getWalletDbPool()
  const { rows } = await db.query(
    `SELECT e.id, e.amount_paise
       FROM wallet.entries e
      WHERE e.cart_id = $1
        AND e.entry_type = 'redemption'
        AND NOT EXISTS (
          SELECT 1 FROM wallet.entries r
           WHERE r.entry_type = 'reversal' AND r.source_entry_id = e.id
        )
      ORDER BY e.created_at DESC
      LIMIT 1`,
    [cartId]
  )

  if (!rows[0]) return null
  return { entryId: rows[0].id, amountPaise: Math.abs(Number(rows[0].amount_paise)) }
}

export interface CartCreditQuote {
  /** What could be applied to this cart right now. */
  applicablePaise: number
  balancePaise: number
  /**
   * What the customer would pay if they used no credit — the figure on their screen, after any
   * coupon and including delivery and tax. The cap is a percentage of this.
   */
  payablePaise: number
  /**
   * What the platform will let credit cover: goods after discount, never delivery or tax.
   *
   * A hard ceiling rather than a policy — Medusa applies a gift card against the discounted item
   * total and refuses anything above it, so offering more would produce a checkout error rather than
   * a bigger discount.
   */
  redeemablePaise: number
  /** What is already applied, if the customer has applied it. */
  appliedPaise: number
  limitedBy: "balance" | "order" | "cap" | "nothing_to_apply"
}

/**
 * What the customer could put towards this cart.
 *
 * ── Why the ceiling is passed in rather than computed ──────────────────────────────────────────
 * "How much of this cart may credit cover" is Medusa's answer, not ours: it is the items after any
 * campaign, excluding delivery and tax, and it is assembled by the totals service. Computing a second
 * opinion here would produce a figure that is right until the first time a campaign behaves in a way
 * this file did not predict, and the symptom would be a customer offered credit that checkout then
 * refuses to take in full.
 *
 * ── Why the OPS cap is still consulted ─────────────────────────────────────────────────────────
 * It is the business's lever and it stays where the business can reach it. At 100% — where it sits
 * today — it takes nothing away, which is the point of leaving it configurable rather than removing
 * it because it currently binds nothing.
 */
export async function quoteCartCredit(params: {
  customerId: string
  cartId: string
  brand: Brand
  pincode: string | null
  /** What the customer would pay with no credit applied. The cap is measured against this. */
  payablePaise: number
  /** The platform's own ceiling on what a gift card may cover. */
  redeemablePaise: number
}): Promise<CartCreditQuote> {
  const [balancePaise, economics, applied] = await Promise.all([
    getBalance(params.customerId).then((b) => Math.max(0, b)),
    getEffectiveConfig(params.brand, params.pincode, "economics"),
    getCartCredit(params.cartId),
  ])

  /**
   * The cap is a share of what the customer pays, not of what the items cost.
   *
   * ── Why this changed ─────────────────────────────────────────────────────────────────────────
   * It used to be measured against the discounted item total, which is a number nobody sees. An
   * order of several items with a coupon on it has an item total, a discount, a delivery charge and
   * a tax line, and the only figure the customer recognises is the one at the bottom. "Up to 15% of
   * your order" has to mean 15% of that, or the percentage means something different on every basket
   * and cannot be explained to anybody.
   *
   * The platform ceiling below is separate and still applies: Medusa will not let a gift card cover
   * delivery or tax whatever the cap says, so at a high cap the ceiling is what binds, and the
   * customer is told that rather than offered credit checkout would refuse.
   */
  const capBps = Number(economics?.params.promo_redemption_cap_bps ?? 10000)
  const capPaise = Math.floor((params.payablePaise * capBps) / 10000)
  const ceiling = Math.max(0, Math.min(balancePaise, params.redeemablePaise, capPaise))

  /**
   * Which limit actually bound, reported in the order a customer would care about.
   *
   * The cap is only named when it is strictly tighter than the order. At 100% — where it sits by
   * default — the cap and the order value are the same number, so a naive "is the cap the smallest"
   * test reports the cap every single time the order is the real limit, and an operator reading
   * "limited by the cap" would go looking for a setting that is doing nothing.
   */
  let limitedBy: CartCreditQuote["limitedBy"] = "nothing_to_apply"
  if (ceiling > 0) {
    if (balancePaise <= Math.min(params.redeemablePaise, capPaise)) limitedBy = "balance"
    else if (capPaise < params.redeemablePaise) limitedBy = "cap"
    else limitedBy = "order"
  }

  return {
    applicablePaise: ceiling,
    balancePaise,
    payablePaise: params.payablePaise,
    redeemablePaise: params.redeemablePaise,
    appliedPaise: applied?.amountPaise ?? 0,
    limitedBy,
  }
}

export type ApplyResult =
  | { applied: true; entryId: string; amountPaise: number }
  | { applied: false; reason: "already_applied" | "nothing_to_apply"; amountPaise: number }

export function isNotApplied(
  result: ApplyResult
): result is Extract<ApplyResult, { applied: false }> {
  return result.applied === false
}

/**
 * Takes the credit out of the wallet, against this cart.
 *
 * ── Why the whole thing serialises on the cart ─────────────────────────────────────────────────
 * Two clicks on "apply", or a click and a retry, are the ordinary case rather than the exotic one —
 * a slow response is exactly what makes somebody press a button twice. Both requests would find no
 * existing redemption and both would debit. A unique index cannot express the rule, because the rule
 * is "at most one that has not been reversed" and a customer may legitimately remove their credit and
 * apply it again. So the check and the write happen under a lock keyed on the cart, which is released
 * when the transaction ends.
 */
export async function applyCartCredit(params: {
  customerId: string
  cartId: string
  brand: Brand
  pincode: string | null
  payablePaise: number
  redeemablePaise: number
  requestedPaise?: number
}): Promise<ApplyResult> {
  const pool = getWalletDbPool()
  const client = await pool.connect()

  try {
    await client.query("BEGIN")
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cart_credit:${params.cartId}`])

    const existing = await getCartCredit(params.cartId, client as any)
    if (existing) {
      await client.query("ROLLBACK")
      return { applied: false, reason: "already_applied", amountPaise: existing.amountPaise }
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }

  /**
   * Quoted outside the lock, and redeem takes its own.
   *
   * redeem locks the customer's grant rows for its own transaction, and holding the cart lock across
   * it would mean two locks taken in an order this file cannot guarantee elsewhere. The cost of
   * letting go is that a second request could arrive here — and redeem is itself atomic, so the worst
   * case is a second redemption on the cart, which the route then removes when it finds the gift card
   * already attached. Credit is never lost, only briefly double-held.
   */
  const quote = await quoteCartCredit(params)
  const wanted = Math.min(quote.applicablePaise, params.requestedPaise ?? quote.applicablePaise)

  if (wanted <= 0) {
    return { applied: false, reason: "nothing_to_apply", amountPaise: 0 }
  }

  const result = await redeem({
    customerId: params.customerId,
    requestedPaise: wanted,
    brand: params.brand,
    cartId: params.cartId,
  })

  return { applied: true, entryId: result.entryId, amountPaise: result.redeemedPaise }
}

/**
 * Puts the credit back.
 *
 * Writes a reversal pointing at the redemption, which is all that is needed: every balance query
 * ignores allocations whose consumer has been reversed, so the lots the redemption consumed become
 * spendable again the moment this row exists. Nothing is edited and nothing is deleted.
 *
 * Returns what was put back, or zero when there was nothing applied — so a customer clicking remove
 * twice, or a sweeper running over a cart somebody already cleared, is a no-op rather than an error.
 */
export async function releaseCartCredit(params: {
  cartId: string
  reason: string
}): Promise<{ releasedPaise: number }> {
  const pool = getWalletDbPool()
  const client = await pool.connect()

  try {
    await client.query("BEGIN")
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cart_credit:${params.cartId}`])

    const { rows } = await client.query(
      `SELECT e.id, e.customer_id, e.amount_paise, e.brand
         FROM wallet.entries e
        WHERE e.cart_id = $1
          AND e.entry_type = 'redemption'
          AND NOT EXISTS (
            SELECT 1 FROM wallet.entries r
             WHERE r.entry_type = 'reversal' AND r.source_entry_id = e.id
          )`,
      [params.cartId]
    )

    let releasedPaise = 0
    for (const row of rows) {
      const amount = Math.abs(Number(row.amount_paise))
      await client.query(
        `INSERT INTO wallet.entries
           (customer_id, entry_type, amount_paise, brand, cart_id, source_entry_id, reason)
         VALUES ($1, 'reversal', $2, $3, $4, $5, $6)`,
        [row.customer_id, amount, row.brand, params.cartId, row.id, params.reason]
      )
      releasedPaise += amount
    }

    await client.query("COMMIT")
    return { releasedPaise }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * Gives back credit held by carts that were never completed.
 *
 * ── Why a sweep and not a cart-expiry hook ─────────────────────────────────────────────────────
 * An abandoned cart produces no event. The customer closes the tab, and nothing anywhere knows it is
 * over — which is exactly the shape that needs a job asking "what has been sitting here too long"
 * rather than a handler waiting for something that never arrives.
 *
 * ── Why a cart that became an order is left alone ──────────────────────────────────────────────
 * Its credit was spent, correctly, and the order records the cart it came from — so "did this become
 * an order" is a join and not a guess. Reversing one of those would hand back credit the customer
 * already received a discount for.
 *
 * ── The age, and why it is generous ────────────────────────────────────────────────────────────
 * A customer who applies credit, goes to find their card, and is interrupted for an hour must come
 * back to the checkout they left. The cost of waiting is credit that looks spent for a few hours on a
 * cart nobody will finish; the cost of being hasty is a discount vanishing between a customer
 * entering their card details and pressing pay.
 */
export async function releaseStaleCartCredit(params: {
  olderThanHours?: number
  at?: Date
  /**
   * Whether this cart's credit is genuinely still unspent.
   *
   * Injected because answering it means reading the gift card Medusa holds, and nothing in this
   * directory talks to Medusa. Defaults to yes for tests that are not about that question.
   *
   * It exists to close a real hole: the gift card carries a code, and the customer can read it off
   * their own cart. Copy it, spend it on a second order, then abandon the first cart — and a sweeper
   * that reversed blindly would hand the credit back after it had already been used. The resolver
   * says no when the card has been touched, and the debit stands.
   */
  canRelease?: (cartId: string) => Promise<boolean>
} = {}): Promise<{ carts: number; releasedPaise: number; withheld: number }> {
  const hours = params.olderThanHours ?? 6
  const at = params.at ?? new Date()

  const { rows } = await getWalletDbPool().query(
    `SELECT DISTINCT e.cart_id
       FROM wallet.entries e
      WHERE e.cart_id IS NOT NULL
        AND e.entry_type = 'redemption'
        AND e.created_at < $1::timestamptz - ($2 || ' hours')::interval
        AND NOT EXISTS (
          SELECT 1 FROM wallet.entries r
           WHERE r.entry_type = 'reversal' AND r.source_entry_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public."order" o WHERE o.cart_id = e.cart_id
        )`,
    [at, String(hours)]
  )

  let releasedPaise = 0
  let carts = 0
  let withheld = 0

  for (const row of rows) {
    /* One cart's failure must not strand every later cart's credit, so each is released on its own
       and a failure is logged rather than thrown. */
    try {
      if (params.canRelease && !(await params.canRelease(row.cart_id))) {
        withheld += 1
        console.warn(
          `[wallet] credit on abandoned cart ${row.cart_id} was not returned: its gift card has ` +
            `already been used. The debit stands; this needs a person to look at it.`
        )
        continue
      }

      const result = await releaseCartCredit({
        cartId: row.cart_id,
        reason: `Cart abandoned — credit returned after ${hours}h`,
      })
      if (result.releasedPaise > 0) {
        carts += 1
        releasedPaise += result.releasedPaise
      }
    } catch (error) {
      console.error(
        `[wallet] could not release credit on abandoned cart ${row.cart_id}: ` +
          `${error instanceof Error ? error.message : error}`
      )
    }
  }

  return { carts, releasedPaise, withheld }
}
