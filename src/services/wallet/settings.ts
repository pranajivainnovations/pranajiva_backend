import { getWalletDbPool } from "./db"

/**
 * Operational switches for the wallet.
 *
 * Small on purpose. Rates and limits belong in the versioned reward config, where a value stays
 * pinned to the rows it produced; these are switches that change behaviour from now on and have no
 * arithmetic frozen onto anything.
 */

export type ClawbackPolicy = "write_off" | "allow_negative"

const DEFAULT_CLAWBACK: ClawbackPolicy = "write_off"

/**
 * What to do when an order is refunded after its reward has already been spent.
 *
 * Falls back to write_off on anything unexpected — a missing row, a typo in the value, a database
 * that answered oddly. The two policies differ in who absorbs a small loss, and the safe default is
 * the one where the customer is never shown a negative balance by accident. Choosing to pursue the
 * money should take a deliberate act; choosing not to should be what happens when something is
 * unclear.
 */
export async function getClawbackPolicy(): Promise<ClawbackPolicy> {
  try {
    const { rows } = await getWalletDbPool().query(
      `SELECT value FROM wallet.settings WHERE key = 'refund_clawback_policy'`
    )
    const value = rows[0]?.value
    return value === "allow_negative" || value === "write_off" ? value : DEFAULT_CLAWBACK
  } catch (error) {
    console.error("[wallet] could not read the clawback policy; using write_off", error)
    return DEFAULT_CLAWBACK
  }
}

/**
 * Is anything allowed to grant right now?
 *
 * ── Why absence reads as ON ────────────────────────────────────────────────────────────────────
 * The opposite would be safer-sounding and wrong. A missing row, an unreachable database, a typo in
 * a value — none of those are somebody deciding to stop rewards, and treating them as one produces
 * an outage whose only symptom is that nothing happens, which is the hardest kind to notice and the
 * hardest to diagnose. Rewards stop when an operator says so. Only the exact string "false" stops
 * them, so a value of "off", "no" or "" leaves them running and shows up as an odd-looking row
 * rather than as silence.
 *
 * The inverse of the clawback policy's default, and for the inverse reason: there, an unclear answer
 * should not cost a customer money; here, an unclear answer should not quietly stop the business.
 */
export async function areRewardsGloballyEnabled(): Promise<boolean> {
  try {
    const { rows } = await getWalletDbPool().query(
      `SELECT value FROM wallet.settings WHERE key = 'rewards_globally_enabled'`
    )
    return rows[0]?.value !== "false"
  } catch (error) {
    console.error("[wallet] could not read the global switch; assuming rewards are on", error)
    return true
  }
}

export interface SwitchFlip {
  key: string
  oldValue: string | null
  newValue: string
  reason: string
  changedBy: string | null
  changedAt: Date
}

/**
 * Change an operational switch, and record who and why.
 *
 * The reason is not optional and not defaulted. A trail that says rewards stopped on Saturday and
 * not why is a trail that has to be reconstructed from memory a week later, usually incorrectly.
 *
 * The write and the log entry share a transaction, so a flip is never recorded without taking
 * effect and never takes effect without being recorded.
 */
export async function setSetting(params: {
  key: string
  value: string
  reason: string
  actorOpsUserId?: string | null
}): Promise<SwitchFlip> {
  if (!params.reason?.trim()) {
    throw new Error("[wallet] a settings change needs a reason")
  }

  const pool = getWalletDbPool()
  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    const { rows: before } = await client.query(
      `SELECT value FROM wallet.settings WHERE key = $1 FOR UPDATE`,
      [params.key]
    )
    const oldValue: string | null = before[0]?.value ?? null

    await client.query(
      `INSERT INTO wallet.settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value,
              updated_by = EXCLUDED.updated_by,
              updated_at = NOW()`,
      [params.key, params.value, params.actorOpsUserId ?? null]
    )

    const { rows } = await client.query(
      `INSERT INTO wallet.settings_log (key, old_value, new_value, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [params.key, oldValue, params.value, params.reason.trim(), params.actorOpsUserId ?? null]
    )

    await client.query("COMMIT")

    const r = rows[0]
    return {
      key: r.key,
      oldValue: r.old_value,
      newValue: r.new_value,
      reason: r.reason,
      changedBy: r.changed_by,
      changedAt: r.changed_at,
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Every flip of one switch, newest first. */
export async function getSwitchHistory(key: string, limit = 50): Promise<SwitchFlip[]> {
  const safe = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 200) : 50
  const { rows } = await getWalletDbPool().query(
    `SELECT * FROM wallet.settings_log WHERE key = $1 ORDER BY changed_at DESC LIMIT $2`,
    [key, safe]
  )
  return rows.map((r) => ({
    key: r.key,
    oldValue: r.old_value,
    newValue: r.new_value,
    reason: r.reason,
    changedBy: r.changed_by,
    changedAt: r.changed_at,
  }))
}
