import { OrderService, type ScheduledJobArgs, type ScheduledJobConfig } from "@medusajs/medusa"

import { sweepReferralPayouts } from "../services/wallet/referral-payout"

/**
 * Pays referrers for orders whose return window has closed — GS-5.2.
 *
 * ── Why this job may be late but must not be wrong ─────────────────────────────────────────────
 * Unlike the expiry sweep, this one hands out money, so the trade is the other way round. A missed
 * night costs a referrer a day's patience and nothing else — every candidate is still a candidate
 * tomorrow, because the sweep decides from delivery dates rather than from when it last ran. What it
 * must never do is pay twice, and that is not left to this job's reliability: the unique index on
 * (customer_id, entry_type, order_id) refuses a second reward for the same order however many times
 * this runs.
 *
 * ── Why it runs after the expiry sweep ─────────────────────────────────────────────────────────
 * No functional dependency; they touch different rows. Half an hour apart so that a slow night on
 * one does not overlap the other on the same connection pool, and so the logs read in an order that
 * matches what happened.
 *
 * ── Which 03:30 ────────────────────────────────────────────────────────────────────────────────
 * The container's, which is UTC, so 09:00 in Delhi. Same reasoning as expire-wallet-credit: the
 * schedule takes a bare cron expression with no timezone, and an expression that says 3 while meaning
 * something else is a trap for whoever next sets TZ. Nothing here is on a customer's path.
 */
export default async function payReferralCredit({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")

  try {
    const orderService: OrderService = container.resolve("orderService")

    /**
     * What an order is worth for commission.
     *
     * ── Why Medusa is asked rather than the line items added up ──────────────────────────────────
     * A Medusa order has no stored total; it is assembled from line items, discounts, taxes and
     * shipping by the totals service. Summing `unit_price * quantity` in SQL would produce a number
     * that ignores every coupon ever applied, and it would drift from Medusa's own arithmetic the
     * first time anything about pricing changed. This asks the same service the customer's invoice
     * came from.
     *
     * ── Why shipping is subtracted ───────────────────────────────────────────────────────────────
     * Commission is paid on the cake, not the courier — delivery is close to a pass-through cost, and
     * paying a share of it would mean a referrer earns more from a distant delivery than a nearby
     * one. See the engine's header.
     *
     * ── Why a failure here returns null ──────────────────────────────────────────────────────────
     * An order that cannot be read is not an order worth nothing. Null makes the engine skip it and
     * leave it for tomorrow, rather than granting zero — which the ledger would refuse anyway — or
     * guessing at a figure that becomes somebody's credit.
     */
    const resolveOrderValue = async (orderId: string): Promise<number | null> => {
      try {
        /* No select or relations, matching the refund subscriber, which reads `total` the same way
           and is the one piece of this that production has already exercised. Totals are computed
           rather than stored, so narrowing the select is how you end up with an undefined total. */
        const order = await orderService.retrieve(orderId)

        const total = Number(order.total ?? 0)
        const shipping = Number(order.shipping_total ?? 0)
        if (!Number.isFinite(total)) return null

        return Math.max(0, total - (Number.isFinite(shipping) ? shipping : 0))
      } catch (error) {
        logger.warn(
          `[wallet] could not read the value of order ${orderId} for a referral payout: ` +
            `${error instanceof Error ? error.message : error}`
        )
        return null
      }
    }

    const result = await sweepReferralPayouts({ resolveOrderValue })

    /* Silent when there was nothing to consider, which is most nights early on. A line every night
       would bury the first one that actually pays somebody. */
    if (result.paid > 0) {
      logger.info(
        `[wallet] paid ${result.paid} referral reward(s), ` +
          `₹${(result.paidPaise / 100).toFixed(2)} in total`
      )
    }

    /**
     * Logged only when something was owed and refused.
     *
     * "Considered 40, paid 0" is the signature of a misconfigured offer — switched off, or a budget
     * exhausted nobody noticed — and it is invisible if the job only speaks when it succeeds. The
     * reasons are printed because they distinguish the two cases that matter: still on hold, which is
     * normal and resolves itself, and mechanic unavailable, which does not.
     */
    if (result.considered > 0 && result.paid === 0) {
      logger.info(
        `[wallet] ${result.considered} referral candidate(s), none paid: ` +
          (Object.entries(result.skipped)
            .map(([reason, n]) => `${reason} ${n}`)
            .join(", ") || "no reason recorded")
      )
    }

    if (result.failures > 0) {
      logger.warn(
        `[wallet] ${result.failures} referral payout(s) could not be written; they retry tomorrow`
      )
    }
  } catch (error) {
    /* Caught, never rethrown: an unhandled error in a scheduled job can take the worker down, and a
       dead worker means every later job is missed too. */
    logger.error(
      `[wallet] referral payout sweep failed: ${error instanceof Error ? error.message : error}`
    )
  }
}

export const config: ScheduledJobConfig = {
  name: "pay-referral-credit",
  schedule: "30 3 * * *",
  data: {},
}
