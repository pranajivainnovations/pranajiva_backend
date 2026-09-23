import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getOrdersDbPool } from "../../../../services/orders/db"

/**
 * GET /store/orders/:id — one order, as the customer who placed it.
 *
 * ── Whose order ────────────────────────────────────────────────────────────────────────────────
 * The customer id comes from the verified token and is part of the WHERE clause, not a check
 * performed after the read. An order belonging to somebody else is not found rather than refused —
 * a 403 would confirm that the id exists, which is a small thing to leak but a free one to avoid.
 *
 * ── Why it carries its own events ──────────────────────────────────────────────────────────────
 * A confirmation screen answers two questions: did it work, and what happens now. The second needs
 * the history, and it is the same list the customer sees if they come back a week later to ask
 * where their cake is. One read, both answers.
 *
 * GET is the only export, so this route cannot move an order along. Status changes are an ops act
 * and live behind the service key.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id
  const orderId = req.params.id

  if (!customerId) {
    res.status(401).json({ error: "Sign in to see your order.", code: "AUTH_REQUIRED" })
    return
  }

  try {
    const db = getOrdersDbPool()

    const { rows } = await db.query(
      `SELECT id, display_id, brand, subtotal_paise, delivery_paise, credit_applied_paise,
              payable_paise, payment_status, status, address, created_at
         FROM orders.orders
        WHERE id = $1::uuid AND customer_id = $2`,
      [orderId, customerId]
    )

    if (!rows.length) {
      res.status(404).json({ error: "We could not find that order.", code: "not_found" })
      return
    }
    const order = rows[0]

    /* Items and history together — the page needs both and neither depends on the other. */
    const [items, events] = await Promise.all([
      db.query(
        `SELECT id, kind, ref_id, title, qty, unit_price_paise, spec
           FROM orders.order_items WHERE order_id = $1::uuid`,
        [orderId]
      ),
      db.query(
        `SELECT status, at, note FROM orders.order_events
          WHERE order_id = $1::uuid ORDER BY at`,
        [orderId]
      ),
    ])

    res.status(200).json({
      order: {
        id: order.id,
        displayId: order.display_id,
        brand: order.brand,
        subtotalPaise: order.subtotal_paise,
        deliveryPaise: order.delivery_paise,
        creditAppliedPaise: order.credit_applied_paise,
        payablePaise: order.payable_paise,
        paymentStatus: order.payment_status,
        status: order.status,
        address: order.address,
        createdAt: order.created_at,
        items: items.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          refId: r.ref_id,
          title: r.title,
          qty: r.qty,
          unitPricePaise: r.unit_price_paise,
          linePaise: r.qty * r.unit_price_paise,
          spec: r.spec ?? {},
        })),
        events: events.rows.map((r) => ({ status: r.status, at: r.at, note: r.note })),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[store/orders/:id] ${orderId}: ${message}`)
    res.status(500).json({ error: "Could not read that order.", code: "unexpected" })
  }
}
