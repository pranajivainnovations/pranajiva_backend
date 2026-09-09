import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { getBakerNetworkDbPool } from "../services/baker-network/db"
import { drainDueReminders } from "../services/reminders/deliver"

/**
 * Sends the reminders that have come due.
 *
 * ── Why this job is deliberately thin ──────────────────────────────────────────────────────────
 * Everything that decides *what* to send is in the delivery queue, written down before the moment
 * arrives. This is only the thing that wakes up and drains it. That separation is the whole
 * reliability argument: a scheduled job is the least trustworthy part of any system — it silently
 * stops, it runs twice after a deploy, it misses a window during a restart — so nothing important
 * may depend on it having run at a particular instant.
 *
 * A missed run costs lateness, not loss. Rows stay pending and go out on the next pass.
 *
 * ── Why every minute ───────────────────────────────────────────────────────────────────────────
 * Reminders are scheduled to the hour, so a minute of granularity is far finer than needed. It is
 * not there for precision — it is there so that a run which fails, or a container which restarts,
 * costs sixty seconds of delay rather than an hour. The query is a partial-index lookup that returns
 * nothing almost every time, which is a rounding error against the database's day.
 */
export default async function sendReminders({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")

  try {
    const result = await drainDueReminders(getBakerNetworkDbPool())

    /* Silent when there was nothing to do, which is almost every minute — a log line per minute
       would bury the one that matters. Anything that failed is always reported. */
    if (result.claimed > 0) {
      logger.info(
        `[reminders] claimed ${result.claimed}, sent ${result.sent}, retrying ${result.retried}, failed ${result.failed}`
      )
    }
    if (result.failed > 0) {
      logger.warn(`[reminders] ${result.failed} reminder(s) gave up after repeated failures`)
    }
  } catch (error) {
    /**
     * Caught, never rethrown.
     *
     * An unhandled error in a scheduled job can take the worker down with it, and a dead worker
     * means every reminder after this one is also missed — turning one bad minute into an outage
     * nobody notices until somebody's birthday has passed.
     */
    logger.error(`[reminders] drain failed: ${error instanceof Error ? error.message : error}`)
  }
}

export const config: ScheduledJobConfig = {
  name: "send-due-reminders",
  schedule: "* * * * *",
  data: {},
}
