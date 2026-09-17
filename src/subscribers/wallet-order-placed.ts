import { OrderService, type SubscriberArgs, type SubscriberConfig } from "@medusajs/medusa"

import { isNotGranted, issueJoiningCash } from "../services/wallet/joining-cash"
import type { Brand } from "../services/wallet/ledger"

/**
 * Issues joining cash when an order is placed.
 *
 * ── Why this file needs to exist at all ────────────────────────────────────────────────────────
 * The grant engine was built, tested and left with no caller. Everything about joining cash worked
 * except that nothing ever asked it a question, so an offer could be configured, switched on in OPS
 * and shown as running while issuing precisely nothing. This is the thing that asks.
 *
 * ── Why on placement rather than on delivery ───────────────────────────────────────────────────
 * The customer was told ₹100 unlocks on their first order, and the moment an order exists is the
 * moment that promise comes due; making them wait for delivery to see it would make the wallet look
 * broken for two days. The risk that the order is then cancelled is handled where it belongs, by the
 * refund subscriber, which reverses grants on a cancelled or fully refunded order.
 *
 * ── Why a failure here is swallowed ────────────────────────────────────────────────────────────
 * This runs after the order is placed and paid for. An exception that propagated could retry the
 * event, log an error against a perfectly good order, or — depending on how the event bus is feeling
 * — appear to the customer as a failed checkout. No reward is worth a broken order, so everything is
 * caught and logged. A grant that was missed can be issued later; a checkout that failed cannot be
 * un-failed.
 *
 * ── Why running twice is safe ──────────────────────────────────────────────────────────────────
 * Event handlers redeliver. The unique index on (customer_id, entry_type, order_id) means a second
 * delivery writes nothing, and the engine counts the customer's existing grants before deciding which
 * grant this is — so a redelivery cannot turn one order into two grants.
 */

type OrderPlacedEvent = { id: string }

/**
 * Which brand this order came from.
 *
 * The sales channel is the only place a Medusa order records which storefront it was placed on.
 * Matched on name rather than id because ids differ between databases, and a hardcoded id fails
 * silently in exactly the environment that matters. Unknown or absent means CrossFriend, which is the
 * brand the growth system exists for — and a wrong brand here would read a different configuration
 * rather than cause an error, so it is worth saying which way it falls.
 */
function brandOf(channelName: string | null | undefined): Brand {
  return String(channelName ?? "").toLowerCase() === "pranajiva" ? "pranajiva" : "crossfriend"
}

/**
 * Whether this order was paid up front.
 *
 * ── What this currently returns, and why that is worth knowing ──────────────────────────────────
 * A payment counts as prepaid when it was taken by a real payment provider and captured. Today only
 * `manual` is installed in Medusa — Razorpay is registered but not installed — so every Medusa order
 * is a manual payment and this reads false for all of them. Which means `prepaid_only: true` refuses
 * every order in the system right now.
 *
 * That is reported rather than fudged. The alternative, treating manual as prepaid, would make the
 * setting silently meaningless and remove the protection it exists for: the refuse-at-the-door abuse
 * where a cash order is rejected after the reward has been earned. When Razorpay is installed
 * properly this starts returning true on its own, with no change here.
 */
function isPrepaid(
  payments: { provider_id?: string; captured_at?: string | Date | null }[]
): boolean {
  return payments.some(
    (p) => p.provider_id && p.provider_id !== "manual" && p.captured_at != null
  )
}

export default async function walletOrderPlaced({
  data,
  container,
}: SubscriberArgs<OrderPlacedEvent>): Promise<void> {
  const logger = container.resolve("logger")

  try {
    const orderService: OrderService = container.resolve("orderService")
    const order = await orderService.retrieve(data.id, {
      relations: ["shipping_address", "payments", "sales_channel"],
    })

    /* A guest order has nobody to credit. Nothing is wrong; there is simply no wallet. */
    if (!order.customer_id) return

    const outcome = await issueJoiningCash({
      customerId: order.customer_id,
      orderId: order.id,
      brand: brandOf(order.sales_channel?.name),
      pincode: order.shipping_address?.postal_code ?? null,
      /**
       * What the customer paid, delivery included.
       *
       * The minimum order is a figure a customer recognises from their own basket, and a ₹699
       * minimum that silently meant ₹699-before-delivery would refuse somebody who saw ₹720 on
       * their screen and would be right to complain. The referral commission takes the opposite
       * view for a different reason — see referral-payout.
       */
      totalPaise: Number(order.total ?? 0),
      isPrepaid: isPrepaid(order.payments ?? []),
      shippingAddress: order.shipping_address
        ? {
            line1: order.shipping_address.address_1,
            line2: order.shipping_address.address_2,
            city: order.shipping_address.city,
            postalCode: order.shipping_address.postal_code,
          }
        : null,
    })

    if (!isNotGranted(outcome)) {
      logger.info(
        `[wallet] order ${order.id}: granted joining cash ${outcome.which} of 2, ` +
          `₹${(outcome.amountPaise / 100).toFixed(2)}` +
          (outcome.expiresAt ? `, expires ${outcome.expiresAt.toISOString().slice(0, 10)}` : "") +
          (outcome.honoured ? " (honouring a promise made before the offer closed)" : "")
      )
      return
    }

    /**
     * Refusals are logged at debug, with one exception.
     *
     * Most refusals are the system working: the customer already has both grants, the order is below
     * the minimum, the offer is not running here. Logging those at info would produce a line per
     * order forever. `mechanic_unavailable` is different — it is the one that means an offer somebody
     * switched on is not actually reaching anybody, which is worth seeing without turning on debug.
     */
    if (outcome.reason === "mechanic_unavailable") {
      logger.info(`[wallet] order ${order.id}: no joining cash — ${outcome.explanation}`)
    } else {
      logger.debug(`[wallet] order ${order.id}: no joining cash — ${outcome.reason}`)
    }
  } catch (error) {
    logger.error(
      `[wallet] joining cash failed for order ${data.id}: ` +
        `${error instanceof Error ? error.message : error}`
    )
  }
}

export const config: SubscriberConfig = {
  event: OrderService.Events.PLACED,
}
