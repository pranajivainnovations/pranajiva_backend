import { getWalletDbPool } from "./db"
import { getClawbackPolicy, type ClawbackPolicy } from "./settings"

/**
 * The two things that take credit back: time, and a refund.
 *
 * ── Why expiry needs a clock at all ────────────────────────────────────────────────────────────
 * Spending already respects expiry — an expired grant is simply not offered to the resolver, so
 * nobody can spend it a minute past its date whether this ever runs or not. What is missing without
 * it is the *record*. The ledger would show ₹100 arriving and never leaving, the liability report
 * would count money we no longer owe, and "where did my ₹100 go" would have no answer. A date
 * passing is not an event anything announces, so only something on a timer can write it down.
 *
 * That also means a late run costs accuracy in a report, never money. Nothing here is on the path
 * of a customer trying to check out.
 *
 * ── Why both operations are idempotent ─────────────────────────────────────────────────────────
 * Scheduled jobs run twice after a deploy and subscribers redeliver. Both operations below work by
 * consuming what remains of a grant, so a second run finds nothing remaining and writes nothing.
 * There is no "already processed" flag to get out of step with reality.
 */

export interface SweepResult {
  grantsProcessed: number
  paiseExpired: number
  failures: number
}

/**
 * Writes the expiry entries for credit whose date has passed.
 *
 * One transaction per grant rather than one for the batch: a single malformed row should cost its
 * own expiry, not the other four hundred. The loop is bounded so a first run against a long-dormant
 * system does its work over several passes instead of one enormous transaction.
 */
export async function expireDueCredit(limit = 500): Promise<SweepResult> {
  const pool = getWalletDbPool()
  const result: SweepResult = { grantsProcessed: 0, paiseExpired: 0, failures: 0 }

  const { rows: due } = await pool.query(
    `SELECT e.id, e.customer_id, e.brand,
            (e.amount_paise - COALESCE(c.taken, 0))::bigint AS remaining_paise
       FROM wallet.entries e
       LEFT JOIN (
         SELECT a.grant_entry_id, SUM(a.amount_paise)::bigint AS taken
           FROM wallet.allocations a
           JOIN wallet.entries m ON m.id = a.consuming_entry_id
          WHERE NOT EXISTS (
            SELECT 1 FROM wallet.entries r
             WHERE r.entry_type = 'reversal' AND r.source_entry_id = m.id
          )
          GROUP BY a.grant_entry_id
       ) c ON c.grant_entry_id = e.id
      WHERE e.entry_type IN ('promo_grant', 'referral_earn', 'cashback_earn', 'manual_grant')
        AND e.expires_at IS NOT NULL
        AND e.expires_at <= NOW()
        AND (e.amount_paise - COALESCE(c.taken, 0)) > 0
      ORDER BY e.expires_at
      LIMIT $1`,
    [limit]
  )

  for (const grant of due) {
    /* The scanned remaining_paise is only what selected this row. The figure that gets written is
       re-read under a lock below, because it can change between the two. */
    const client = await pool.connect()

    try {
      await client.query("BEGIN")

      /* Re-read under a lock. Between the scan above and this write the customer may have spent the
         very credit we are about to expire — the resolver would have refused, since it is past the
         date, but a redemption already in flight can land in between. Without the re-read the
         expiry entry would take credit that a redemption has also taken, and the two together would
         remove more than the grant ever held. */
      const { rows } = await client.query(
        `SELECT (e.amount_paise - COALESCE((
                  SELECT SUM(a.amount_paise) FROM wallet.allocations a
                    JOIN wallet.entries m ON m.id = a.consuming_entry_id
                   WHERE a.grant_entry_id = e.id
                     AND NOT EXISTS (
                       SELECT 1 FROM wallet.entries r
                        WHERE r.entry_type = 'reversal' AND r.source_entry_id = m.id
                     )
                ), 0))::bigint AS remaining_paise
           FROM wallet.entries e
          WHERE e.id = $1
          FOR UPDATE`,
        [grant.id]
      )

      const stillRemaining = Number(rows[0]?.remaining_paise ?? 0)
      if (stillRemaining <= 0) {
        await client.query("ROLLBACK")
        continue
      }

      const { rows: entry } = await client.query(
        `INSERT INTO wallet.entries (customer_id, entry_type, amount_paise, brand, source_entry_id)
         VALUES ($1, 'expiry', $2, $3, $4)
         RETURNING id`,
        [grant.customer_id, -stillRemaining, grant.brand, grant.id]
      )

      await client.query(
        `INSERT INTO wallet.allocations (consuming_entry_id, grant_entry_id, amount_paise)
         VALUES ($1, $2, $3)`,
        [entry[0].id, grant.id, stillRemaining]
      )

      await client.query("COMMIT")
      result.grantsProcessed++
      result.paiseExpired += stillRemaining
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      result.failures++
      console.error(`[wallet] could not expire grant ${grant.id}`, error)
    } finally {
      client.release()
    }
  }

  return result
}

export interface ClawbackResult {
  policy: ClawbackPolicy
  grantsReversed: number
  paiseReclaimed: number
  /** Credit that was already spent and, under write_off, is not being pursued. */
  paiseWrittenOff: number
}

/**
 * Takes back the rewards granted on an order that has been refunded or cancelled.
 *
 * ── Why this listens for an event instead of polling ───────────────────────────────────────────
 * A refund is announced the moment it happens, so there is no reason for the books to be wrong for
 * up to a day waiting for a timer. Expiry has no such announcement and is why the other half of
 * this file runs on a clock.
 *
 * ── The two policies ───────────────────────────────────────────────────────────────────────────
 * `write_off` reclaims what is left of the grant and lets the rest go. `allow_negative` reverses
 * the full grant, allocating what exists; the unallocated remainder becomes a debt the balance
 * carries. Both write a `reversal` entry pointing at the grant it undoes, so the customer's history
 * explains itself either way.
 *
 * Under write_off, a grant that was spent down to nothing produces no entry at all — there is no
 * money movement to record, and inventing a zero-value one would be a note dressed up as a
 * transaction. The amount is returned instead, so the caller can log it and reporting can show it.
 */
export async function clawbackOrderRewards(orderId: string): Promise<ClawbackResult> {
  const policy = await getClawbackPolicy()
  const pool = getWalletDbPool()
  const result: ClawbackResult = {
    policy,
    grantsReversed: 0,
    paiseReclaimed: 0,
    paiseWrittenOff: 0,
  }

  const { rows: grants } = await pool.query(
    `SELECT id FROM wallet.entries
      WHERE order_id = $1
        AND entry_type IN ('promo_grant', 'referral_earn', 'cashback_earn')
        AND NOT EXISTS (
          SELECT 1 FROM wallet.entries r
           WHERE r.entry_type = 'reversal' AND r.source_entry_id = wallet.entries.id
        )`,
    [orderId]
  )

  for (const g of grants) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")

      const { rows } = await client.query(
        `SELECT e.customer_id, e.brand, e.amount_paise,
                (e.amount_paise - COALESCE((
                   SELECT SUM(a.amount_paise) FROM wallet.allocations a
                     JOIN wallet.entries m ON m.id = a.consuming_entry_id
                    WHERE a.grant_entry_id = e.id
                      AND NOT EXISTS (
                        SELECT 1 FROM wallet.entries r
                         WHERE r.entry_type = 'reversal' AND r.source_entry_id = m.id
                      )
                 ), 0))::bigint AS remaining_paise
           FROM wallet.entries e
          WHERE e.id = $1
          FOR UPDATE`,
        [g.id]
      )

      const grant = rows[0]
      const granted = Number(grant.amount_paise)
      const remaining = Number(grant.remaining_paise)
      const alreadySpent = granted - remaining

      const reverseBy = policy === "allow_negative" ? granted : remaining

      if (reverseBy <= 0) {
        /* write_off, and nothing left to reclaim. No money moves, so nothing is written. */
        await client.query("ROLLBACK")
        result.paiseWrittenOff += alreadySpent
        continue
      }

      const { rows: entry } = await client.query(
        `INSERT INTO wallet.entries
           (customer_id, entry_type, amount_paise, brand, order_id, source_entry_id, reason)
         VALUES ($1, 'reversal', $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          grant.customer_id,
          -reverseBy,
          grant.brand,
          orderId,
          g.id,
          alreadySpent > 0
            ? `Order refunded. ${alreadySpent} paise of ${granted} had already been spent` +
              (policy === "write_off" ? " and is not being reclaimed." : " and is carried as a debt.")
            : "Order refunded.",
        ]
      )

      if (remaining > 0) {
        await client.query(
          `INSERT INTO wallet.allocations (consuming_entry_id, grant_entry_id, amount_paise)
           VALUES ($1, $2, $3)`,
          [entry[0].id, g.id, remaining]
        )
      }

      await client.query("COMMIT")
      result.grantsReversed++
      result.paiseReclaimed += remaining
      if (policy === "write_off") result.paiseWrittenOff += alreadySpent
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      console.error(`[wallet] could not claw back grant ${g.id} for order ${orderId}`, error)
    } finally {
      client.release()
    }
  }

  return result
}
