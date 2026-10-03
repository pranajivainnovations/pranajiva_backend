import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getOrdersDbPool } from "../../../services/orders/db"

/**
 * GET /store/orders — everything this customer has ordered.
 *
 * ── Why a summary rather than the full order ───────────────────────────────────────────────────
 * A list page shows a number, a date, a total and where it has got to. Items and history belong to
 * the one order somebody opens, and /store/orders/:id already returns those. Sending every line of
 * every order to draw a list is the shape of request that makes an account page slow for the people
 * who have used you most.
 *
 * Item titles are the exception: a list that says "Order #1012" and nothing else is a list nobody
 * can read. One line of titles comes back per order, aggregated in the same statement. The totals
 * and the delivery address come too, because they are fixed-size and a list that shows where an
 * order went saves opening it — it is the per-item detail that stays behind /:id.
 *
 * ── Whose orders ───────────────────────────────────────────────────────────────────────────────
 * The customer id comes from the verified token and is part of the WHERE clause. There is no id in
 * the query string to get wrong, so this route cannot be pointed at anybody else.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({ error: "Sign in to see your orders.", code: "AUTH_REQUIRED" })
    return
  }

  try {
    const { rows } = await getOrdersDbPool().query(
      `SELECT o.id, o.display_id, o.brand, o.payable_paise, o.credit_applied_paise,
              o.subtotal_paise, o.delivery_paise, o.payment_method, o.address,
              o.payment_status, o.status, o.created_at,
              COALESCE((
                SELECT json_agg(i.title ORDER BY i.id)
                  FROM orders.order_items i WHERE i.order_id = o.id
              ), '[]'::json) AS titles,
              COALESCE((
                SELECT SUM(i.qty)::int FROM orders.order_items i WHERE i.order_id = o.id
              ), 0) AS item_count
         FROM orders.orders o
        WHERE o.customer_id = $1
        ORDER BY o.created_at DESC
        LIMIT 100`,
      [customerId]
    )

    res.status(200).json({
      orders: rows.map((r) => ({
        id: r.id,
        displayId: r.display_id,
        brand: r.brand,
        payablePaise: r.payable_paise,
        creditAppliedPaise: r.credit_applied_paise,
        subtotalPaise: r.subtotal_paise,
        deliveryPaise: r.delivery_paise,
        paymentMethod: r.payment_method,
        /* A copy on the order, and fixed-size — unlike the items, which stay behind /:id. */
        address: r.address ?? {},
        paymentStatus: r.payment_status,
        status: r.status,
        createdAt: r.created_at,
        titles: (r.titles ?? []) as string[],
        itemCount: r.item_count,
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[store/orders] ${customerId}: ${message}`)
    res.status(500).json({ error: "Could not read your orders.", code: "unexpected" })
  }
}
