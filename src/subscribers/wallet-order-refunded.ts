import { OrderService, type SubscriberArgs, type SubscriberConfig } from "@medusajs/medusa"

import { clawbackOrderRewards } from "../services/wallet/sweeper"

type OrderEvent = { id: string }

/**
 * Takes back wallet credit granted on an order that has been refunded or cancelled.
 *
 * ── Why an event and not the nightly job ───────────────────────────────────────────────────────
 * A refund announces itself the moment it happens, so there is no reason to let the books stay
 * wrong until 3am — and, unlike expiry, this can actually remove spendable credit, so the window
 * matters. Expiry has no announcement to listen for, which is why it is the half that runs on a
 * clock.
 *
 * ── Why a partial refund deliberately changes nothing ──────────────────────────────────────────
 * `order.refund_created` fires for any amount, including a ₹50 goodwill gesture on an ₹800 order.
 * Removing the whole reward for that would punish the customer twice for a problem that was ours,
 * and reclaiming a proportion is a pricing decision — which proportion, rounded which way, against
 * an order total that may itself include credit — that belongs with the reward engine rather than
 * being invented here. So credit is reclaimed only when the order is cancelled outright, or when
 * refunds have come to cover the whole of it.
 *
 * ── Why running twice is safe ──────────────────────────────────────────────────────────────────
 * Event handlers redeliver. The clawback skips grants that already have a reversal pointing at
 * them and reclaims only what remains of the others, so a second delivery finds nothing to do.
 */
export default async function walletOrderRefunded({
  data,
  container,
}: SubscriberArgs<OrderEvent>): Promise<void> {
  const logger = container.resolve("logger")

  try {
    const orderService: OrderService = container.resolve("orderService")
    const order = await orderService.retrieve(data.id)

    const cancelled = order.status === "canceled"
    const fullyRefunded = Number(order.refunded_total ?? 0) >= Number(order.total ?? 0)

    if (!cancelled && !fullyRefunded) {
      return
    }

    const result = await clawbackOrderRewards(order.id)

    if (result.grantsReversed > 0 || result.paiseWrittenOff > 0) {
      logger.info(
        `[wallet] order ${order.id} ${cancelled ? "cancelled" : "fully refunded"}: ` +
          `reversed ${result.grantsReversed} grant(s), ` +
          `reclaimed ₹${(result.paiseReclaimed / 100).toFixed(2)}` +
          (result.paiseWrittenOff > 0
            ? `, wrote off ₹${(result.paiseWrittenOff / 100).toFixed(2)} already spent ` +
              `(policy: ${result.policy})`
            : "")
      )
    }
  } catch (error) {
    /**
     * Caught, never rethrown.
     *
     * A throw here is retried by the event bus and, once it gives up, lost — and the consequence
     * would be credit left in a wallet for an order that no longer exists. Logged loudly instead,
     * so it is recoverable by hand rather than silently absorbed.
     */
    logger.error(
      `[wallet] clawback failed for order ${data.id}: ` +
        `${error instanceof Error ? error.message : error}`
    )
  }
}

export const config: SubscriberConfig = {
  event: [OrderService.Events.REFUND_CREATED, OrderService.Events.CANCELED],
}
