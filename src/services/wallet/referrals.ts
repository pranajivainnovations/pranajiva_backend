import { getWalletDbPool } from "./db"
import type { Brand } from "./ledger"

/**
 * Who referred whom.
 *
 * One row per referred customer, written once and never changed. The whole graph is here to any
 * depth — the table is a parent pointer, so an ancestry query is a recursive CTE away — while
 * payment deliberately reads only {@link getDirectReferrals}. Storing the tree costs nothing;
 * paying past the direct referrer is a separate decision with the Prize Chits Act 1978 and the
 * Direct Selling Rules 2021 behind it, and it should be taken deliberately rather than discovered
 * to be easy because the data was already sitting there.
 *
 * ── Why first-touch, and why it is enforced rather than intended ───────────────────────────────
 * Re-attribution is how referral programmes get gamed: whoever asks last wins, so the incentive is
 * to pester someone who has already decided to buy rather than to find someone new. The primary key
 * on customer_id makes a second attribution fail, and the append-only trigger makes an UPDATE fail,
 * so there is no code path — including a future one written by somebody who has not read this — that
 * can move an edge once it exists.
 */

/** Deep enough for any real chain; a bound so a corrupted graph cannot spin forever. */
const MAX_CHAIN_DEPTH = 64

export type AttributionResult =
  | { status: "attributed" }
  /** Already has a referrer. First touch won; this is the normal outcome of a second attempt. */
  | { status: "already_attributed"; referrerCustomerId: string }
  | { status: "self_referral" }
  /** The referrer is downstream of this customer, so the edge would close a loop. */
  | { status: "would_create_cycle"; throughDepth: number }
  | { status: "unknown_customer" }

/**
 * Record that `customerId` was referred by `referrerCustomerId`.
 *
 * Safe to call more than once: a customer who already has a referrer keeps the first one, and the
 * caller is told so rather than being handed a silent success it might report as a new referral.
 *
 * ── Why the whole operation serialises ─────────────────────────────────────────────────────────
 * The cycle check reads the graph and then writes to it, and two attributions racing each other can
 * both pass a check that neither would pass afterwards: A→B and B→A submitted together each look at
 * a graph where the other edge does not exist yet, and together they close a loop that would then
 * pay both parties forever off each other's orders. An advisory lock makes attribution one-at-a-time.
 *
 * It is a global lock, which would be the wrong instrument for anything frequent. Attribution
 * happens at most once in a customer's life, holds the lock for one indexed walk and one insert, and
 * the alternative — locking the two rows involved — does not help, because the edge that closes the
 * loop can be anywhere in the chain between them.
 */
export async function attributeReferral(params: {
  customerId: string
  referrerCustomerId: string
  brand: Brand
}): Promise<AttributionResult> {
  const { customerId, referrerCustomerId, brand } = params

  if (customerId === referrerCustomerId) return { status: "self_referral" }

  const pool = getWalletDbPool()
  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    /* 4_919_301 is an arbitrary constant; what matters is that every attribution uses the same one.
       Held to the end of the transaction and released automatically, including on rollback. */
    await client.query(`SELECT pg_advisory_xact_lock(4919301)`)

    const known = await client.query(
      `SELECT id FROM public.customer WHERE id = ANY($1) AND deleted_at IS NULL`,
      [[customerId, referrerCustomerId]]
    )
    if (known.rowCount !== 2) {
      await client.query("ROLLBACK")
      return { status: "unknown_customer" }
    }

    const existing = await client.query(
      `SELECT referred_by_customer_id FROM wallet.referrals WHERE customer_id = $1`,
      [customerId]
    )
    if (existing.rowCount) {
      await client.query("ROLLBACK")
      return {
        status: "already_attributed",
        referrerCustomerId: existing.rows[0].referred_by_customer_id,
      }
    }

    /**
     * Walk upward from the proposed referrer. If this customer is anywhere above them, the new edge
     * would point back into its own subtree and close a cycle.
     *
     * A→B→A is the short version and the one anyone tries; the same walk catches A→B→C→A, which is
     * the version that gets tried once someone notices the short one is blocked. The depth bound is
     * what stops the query itself looping if a cycle somehow already exists.
     */
    const cycle = await client.query(
      `WITH RECURSIVE chain(customer_id, depth) AS (
         SELECT $1::text, 0
         UNION ALL
         SELECT r.referred_by_customer_id, chain.depth + 1
           FROM wallet.referrals r
           JOIN chain ON r.customer_id = chain.customer_id
          WHERE chain.depth < $3
       )
       SELECT depth FROM chain WHERE customer_id = $2 LIMIT 1`,
      [referrerCustomerId, customerId, MAX_CHAIN_DEPTH]
    )
    if (cycle.rowCount) {
      await client.query("ROLLBACK")
      return { status: "would_create_cycle", throughDepth: cycle.rows[0].depth }
    }

    await client.query(
      `INSERT INTO wallet.referrals (customer_id, referred_by_customer_id, brand)
       VALUES ($1, $2, $3)`,
      [customerId, referrerCustomerId, brand]
    )

    await client.query("COMMIT")
    return { status: "attributed" }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** The one edge that gets paid. */
export async function getReferrer(customerId: string): Promise<string | null> {
  const { rows } = await getWalletDbPool().query(
    `SELECT referred_by_customer_id FROM wallet.referrals WHERE customer_id = $1`,
    [customerId]
  )
  return rows[0]?.referred_by_customer_id ?? null
}

/**
 * Everyone this customer referred directly — Level 1, and the only level anything pays.
 *
 * Named for what it is rather than "downline", because the word carries an expectation about depth
 * that this system deliberately does not meet.
 */
export async function getDirectReferrals(referrerCustomerId: string): Promise<string[]> {
  const { rows } = await getWalletDbPool().query(
    `SELECT customer_id FROM wallet.referrals
      WHERE referred_by_customer_id = $1 ORDER BY created_at`,
    [referrerCustomerId]
  )
  return rows.map((r) => r.customer_id)
}

/**
 * The chain above a customer, nearest first.
 *
 * For audit and fraud review — "how did these forty accounts get here" — not for payment. Nothing in
 * the reward engine may call this to decide an amount; if that is ever wanted it is a business and
 * legal decision, not a query that happened to be available.
 */
export async function getReferralChain(
  customerId: string,
  maxDepth: number = MAX_CHAIN_DEPTH
): Promise<string[]> {
  const { rows } = await getWalletDbPool().query(
    `WITH RECURSIVE chain(customer_id, depth) AS (
       SELECT $1::text, 0
       UNION ALL
       SELECT r.referred_by_customer_id, chain.depth + 1
         FROM wallet.referrals r
         JOIN chain ON r.customer_id = chain.customer_id
        WHERE chain.depth < $2
     )
     SELECT customer_id, depth FROM chain WHERE depth > 0 ORDER BY depth`,
    [customerId, maxDepth]
  )
  return rows.map((r) => r.customer_id)
}
