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
