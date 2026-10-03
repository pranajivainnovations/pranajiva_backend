import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { cancelAbandonedOrders } from "../services/orders/order"

/**
 * Closes orders nobody paid for, and returns the credit they were holding.
 *
 * ── Why this is the other half of debiting early ───────────────────────────────────────────────
 * release-abandoned-cart-credit covers the cart that never became an order. This covers the order
 * that never became a payment, which was simply not handled: the redemption stood for ever and the
 * customer's balance was short money for a cake that was never made.
 *
 * ── Why 24 hours and not the cart job's 6 ──────────────────────────────────────────────────────
 * A cart with credit on it and no order is already abandoned — nothing more is coming. An order is
 * different: it exists, OPS can see it, and a customer who meant to pay by UPI and got distracted
 * may well come back the same evening. Closing that at six hours would cancel orders people still
 * intend to pay. A day is long enough that anything still unpaid really is not coming, and the
 * credit is idle for at most that long rather than for ever.
 *
 * ── Why it runs off the hour ───────────────────────────────────────────────────────────────────
 * The cart sweep runs at :15. Two jobs that both reverse wallet entries have no reason to contend
 * for the same rows at the same moment, and staggering them makes a log easy to read.
 */
export default async function closeUnpaidOrders({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")

  try {
    const result = await cancelAbandonedOrders({ olderThanHours: 24 })

    if (result.orders > 0) {
      logger.info(
        `[orders] closed ${result.orders} unpaid order(s) and returned ` +
          `₹${(result.releasedPaise / 100).toFixed(2)} of credit`
      )
    }
  } catch (error) {
    /* Caught, never rethrown: an unhandled error in a scheduled job can take the worker down, and
       a dead worker means every later job is missed too. */
    logger.error(
      `[orders] unpaid order sweep failed: ${error instanceof Error ? error.message : error}`
    )
  }
}

export const config: ScheduledJobConfig = {
  name: "close-unpaid-orders",
  schedule: "45 * * * *",
  data: {},
}
