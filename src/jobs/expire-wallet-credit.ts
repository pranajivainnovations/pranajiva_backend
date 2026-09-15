import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { expireDueCredit } from "../services/wallet/sweeper"

/**
 * Writes down the wallet credit whose expiry date has passed.
 *
 * ── Why this is allowed to be unreliable ───────────────────────────────────────────────────────
 * It takes nothing away. Expired credit is already unspendable — the resolver never offers it,
 * whatever this job has or has not done — so a missed run costs a stale liability figure and a gap
 * in one customer's history, not money and not a wrong discount at checkout.
 *
 * That is deliberate, and it is the same principle as the reminders job: a scheduled job is the
 * least trustworthy part of any system, so nothing that matters may depend on it having run at a
 * particular moment.
 *
 * ── Why daily, and why at three in the morning ─────────────────────────────────────────────────
 * The thing being measured is a calendar date, so finer granularity buys nothing: credit expiring
 * today is equally expired at 03:00 and at 23:59, and running every minute would mean a full scan
 * of the ledger fourteen hundred times a day to find nothing. Three in the morning is when the
 * scan's cost is least likely to land beside a customer waiting for a page.
 */
export default async function expireWalletCredit({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")

  try {
    const result = await expireDueCredit()

    /* Silent on a quiet night, which is most of them. A log line per run would bury the one that
       matters, and this one runs whether or not there is anything to say. */
    if (result.grantsProcessed > 0) {
      logger.info(
        `[wallet] expired ${result.grantsProcessed} grant(s), ` +
          `₹${(result.paiseExpired / 100).toFixed(2)} written off the books`
      )
    }
    if (result.failures > 0) {
      logger.warn(`[wallet] ${result.failures} grant(s) could not be expired; they retry tomorrow`)
    }
  } catch (error) {
    /* Caught, never rethrown: an unhandled error in a scheduled job can take the worker down, and
       a dead worker means every later job is missed too — one bad night becoming an outage nobody
       notices until a liability report is quietly wrong for a week. */
    logger.error(
      `[wallet] expiry sweep failed: ${error instanceof Error ? error.message : error}`
    )
  }
}

export const config: ScheduledJobConfig = {
  name: "expire-wallet-credit",
  schedule: "0 3 * * *",
  data: {},
}
