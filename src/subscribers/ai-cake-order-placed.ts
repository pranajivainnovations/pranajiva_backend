import { OrderService, SubscriberArgs, SubscriberConfig } from "@medusajs/medusa"
import { getPricingDbPool } from "../services/pricing/db"

type OrderPlacedEvent = {
  id: string
  no_notification: boolean
}

/**
 * Backfills pricing.price_evaluations.order_id once a cart with an AI Cake Studio line item becomes a
 * real order. The cart-add route (/store/ai-studio/cart) stamps priceEvaluationId onto the line item's
 * metadata at add-to-cart time, before an order exists — this is what closes the loop afterward, so
 * "why was this ₹4,250" can be answered by looking up the evaluation from the order itself, not just
 * from the cart that no longer exists post-checkout.
 */
export default async function aiCakeOrderPlacedHandler({ data, container }: SubscriberArgs<OrderPlacedEvent>) {
  const orderService: OrderService = container.resolve("orderService")

  const order = await orderService.retrieve(data.id, { relations: ["items"] })

  const evaluationIds = order.items
    .map((item) => item.metadata?.priceEvaluationId)
    .filter((id): id is string => typeof id === "string")

  if (evaluationIds.length === 0) return

  const pool = getPricingDbPool()
  await pool.query(`UPDATE pricing.price_evaluations SET order_id = $1 WHERE id = ANY($2)`, [order.id, evaluationIds])
}

export const config: SubscriberConfig = {
  event: OrderService.Events.PLACED,
}
