import { getOrdersDbPool } from "./db"
import { getCart, type Brand, type Cart } from "./cart"
import { createRazorpayOrder, verifyPaid } from "./razorpay"

/**
 * Orders.
 *
 * ── The decision this file exists to enforce ───────────────────────────────────────────────────
 * The order is written BEFORE the payment. Medusa creates it at `cart.complete()` — inside the
 * browser's return path — so a closed tab leaves a successful Razorpay payment and an abandoned
 * cart with nothing connecting them. That is what makes every checkout on the internet beg you not
 * to refresh the page.
 *
 * Here the order exists first, carrying the Razorpay order id, and `payment_status` moves
 * separately. The browser coming back is then a convenience rather than the only way an order can
 * come into being — and UPI collect, where the customer may approve minutes later on another phone,
 * stops being a special case.
 *
 * ── Why markOrderPaid is idempotent ────────────────────────────────────────────────────────────
 * Two paths lead to it and both fire in the ordinary case: the browser returning, and the webhook.
 * Whichever lands first wins and the second is a no-op. That is not an optimisation; it is the only
 * thing that makes running both safe.
 */

export interface PlacedOrder {
  id: string
  displayId: number
  payablePaise: number
  subtotalPaise: number
  creditAppliedPaise: number
  razorpayOrderId: string | null
  paymentStatus: string
  status: string
}

export class OrderError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = "OrderError"
  }
}

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>
}

/**
 * Turn a cart into an order, then ask Razorpay for something to pay against.
 *
 * ── Order of operations, which is the whole point ──────────────────────────────────────────────
 * Cart is validated, the order row is committed, and only then is Razorpay called. If Razorpay is
 * unreachable the customer has an unpaid order they can return to rather than a lost cart — and if
 * the customer vanishes between the two, an order sits in `awaiting` where OPS can see it, instead
 * of nothing existing at all.
 *
 * The reverse order — Razorpay first — is what produces a payment nothing can be matched to.
 */
export async function placeOrder(input: {
  cartId: string
  customerId: string
  address: Record<string, unknown>
}): Promise<{ order: PlacedOrder; cart: Cart }> {
  const cart = await getCart(input.cartId)

  if (!cart) throw new OrderError("no_cart", "Your cart has expired. Please start again.")
  if (cart.status !== "active") {
    /* Already ordered. Returned rather than refused, so a double-submitted checkout lands on the
       order it already made instead of an error. */
    const existing = await findOrderByCart(input.cartId)
    if (existing) return { order: existing, cart }
    throw new OrderError("cart_closed", "That cart has already been ordered.")
  }
  if (!cart.items.length) throw new OrderError("empty_cart", "Your cart is empty.")
  if (cart.customerId && cart.customerId !== input.customerId) {
    throw new OrderError("not_your_cart", "Please start a new cart.", 403)
  }
  if (cart.payablePaise <= 0) {
    /* Fully covered by credit is a real case and needs its own path — there is nothing for Razorpay
       to collect. Refused here rather than sent to a gateway that would reject a zero amount. */
    throw new OrderError(
      "nothing_to_pay",
      "This order is fully covered by your credit. Please contact us to place it."
    )
  }

  const pool = getOrdersDbPool()
  const client = await pool.connect()
  let order: PlacedOrder

  try {
    await client.query("BEGIN")
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cart:${input.cartId}`])

    /* Re-read inside the lock: a second press that got here first has already closed the cart. */
    const { rows: still } = await client.query(
      `SELECT status FROM orders.carts WHERE id = $1`, [input.cartId])
    if (!still.length || still[0].status !== "active") {
      await client.query("ROLLBACK")
      const existing = await findOrderByCart(input.cartId)
      if (existing) return { order: existing, cart }
      throw new OrderError("cart_closed", "That cart has already been ordered.")
    }

    const { rows: created } = await client.query(
      `INSERT INTO orders.orders
         (cart_id, customer_id, brand, subtotal_paise, delivery_paise,
          credit_applied_paise, payable_paise, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, display_id, subtotal_paise, credit_applied_paise, payable_paise,
                 razorpay_order_id, payment_status, status`,
      [
        input.cartId,
        input.customerId,
        cart.brand,
        cart.subtotalPaise,
        cart.deliveryPaise,
        cart.creditAppliedPaise,
        cart.payablePaise,
        JSON.stringify(input.address),
      ]
    )
    order = shape(created[0])

    /* A copy, not a view. What was ordered and what it cost must survive the catalogue and the
       pricing rules moving on — see the note on freezing in the cart service. */
    for (const item of cart.items) {
      await client.query(
        `INSERT INTO orders.order_items
           (order_id, kind, ref_id, title, qty, unit_price_paise, spec, price_evaluation_id)
         SELECT $1, ci.kind, ci.ref_id, $3, ci.qty, ci.unit_price_paise, ci.spec,
                ci.price_evaluation_id
           FROM orders.cart_items ci WHERE ci.id = $2`,
        [order.id, item.id, item.title]
      )
    }

    await client.query(
      `UPDATE orders.carts SET status = 'ordered', updated_at = now() WHERE id = $1`,
      [input.cartId]
    )
    await recordEvent(client, order.id, "placed", "system", "Order placed, awaiting payment")

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }

  /**
   * Razorpay, after the order is safely committed.
   *
   * A failure here leaves a real order in `awaiting` with no razorpay_order_id — recoverable, and
   * visible to OPS. The customer is told to try again, and trying again attaches a payment to the
   * order that already exists rather than creating a second one.
   */
  try {
    const rzp = await createRazorpayOrder({
      amountPaise: order.payablePaise,
      receipt: order.id,
      notes: { order_id: order.id, display_id: String(order.displayId) },
    })
    await getOrdersDbPool().query(
      `UPDATE orders.orders SET razorpay_order_id = $2, updated_at = now() WHERE id = $1`,
      [order.id, rzp.id]
    )
    order.razorpayOrderId = rzp.id
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[orders] order ${order.id} created but Razorpay refused: ${message}`)
    throw new OrderError(
      "gateway_failed",
      "Your order is saved but we could not start the payment. Please try again in a moment.",
      502
    )
  }

  return { order, cart }
}

/**
 * Mark an order paid, once, whichever path gets here first.
 *
 * ── Why it verifies rather than trusts its caller ──────────────────────────────────────────────
 * Both callers are notifications from outside: a browser saying Razorpay told it so, and a webhook
 * saying the same. Neither is evidence. This asks Razorpay directly, every time, and only a
 * `status: "paid"` from them moves anything.
 *
 * ── Why the amount is checked ──────────────────────────────────────────────────────────────────
 * The order Razorpay reports must be for what we asked. Without this, a Razorpay order created for
 * a different cart — or an amount edited between creation and payment — would confirm an order that
 * was never paid for in full.
 */
export async function markOrderPaid(input: {
  razorpayOrderId: string
  razorpayPaymentId?: string | null
  actor?: string
}): Promise<{ changed: boolean; orderId: string | null; reason?: string }> {
  const pool = getOrdersDbPool()

  const { rows } = await pool.query(
    `SELECT id, payable_paise, payment_status FROM orders.orders WHERE razorpay_order_id = $1`,
    [input.razorpayOrderId]
  )
  if (!rows.length) {
    /* A payment for an order we have no record of. Logged loudly: it means money moved against a
       Razorpay order this system did not create, which is either a stale environment pointing at
       the same keys, or something worth a person looking at. */
    console.error(`[orders] paid notification for unknown razorpay order ${input.razorpayOrderId}`)
    return { changed: false, orderId: null, reason: "unknown_order" }
  }

  const order = rows[0]
  if (order.payment_status === "paid") {
    /* The other path got here first. The ordinary case, not an error. */
    return { changed: false, orderId: order.id, reason: "already_paid" }
  }

  const verdict = await verifyPaid(input.razorpayOrderId)
  if (!verdict.paid) {
    return { changed: false, orderId: order.id, reason: `not_paid:${verdict.status}` }
  }
  if (verdict.amountPaise !== order.payable_paise) {
    console.error(
      `[orders] amount mismatch on ${order.id}: razorpay ${verdict.amountPaise}, order ${order.payable_paise}`
    )
    return { changed: false, orderId: order.id, reason: "amount_mismatch" }
  }

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    /* Conditional on still being unpaid, so two simultaneous callers cannot both write the event. */
    const res = await client.query(
      `UPDATE orders.orders
          SET payment_status = 'paid',
              razorpay_payment_id = COALESCE($2, razorpay_payment_id),
              updated_at = now()
        WHERE id = $1 AND payment_status <> 'paid'`,
      [order.id, input.razorpayPaymentId ?? null]
    )

    if (!res.rowCount) {
      await client.query("ROLLBACK")
      return { changed: false, orderId: order.id, reason: "already_paid" }
    }

    await recordEvent(
      client as unknown as Client,
      order.id,
      "placed",
      input.actor ?? "system",
      "Payment confirmed by Razorpay"
    )
    await client.query("COMMIT")
    return { changed: true, orderId: order.id }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Every movement, appended. This is what the MSG91 flows hang off. */
export async function recordEvent(
  client: Client,
  orderId: string,
  status: string,
  actor: string,
  note?: string
): Promise<void> {
  await client.query(
    `INSERT INTO orders.order_events (order_id, status, actor, note) VALUES ($1,$2,$3,$4)`,
    [orderId, status, actor, note ?? null]
  )
}

export async function getOrder(orderId: string): Promise<PlacedOrder | null> {
  const { rows } = await getOrdersDbPool().query(
    `SELECT id, display_id, subtotal_paise, credit_applied_paise, payable_paise,
            razorpay_order_id, payment_status, status
       FROM orders.orders WHERE id = $1`,
    [orderId]
  )
  return rows.length ? shape(rows[0]) : null
}

async function findOrderByCart(cartId: string): Promise<PlacedOrder | null> {
  const { rows } = await getOrdersDbPool().query(
    `SELECT id, display_id, subtotal_paise, credit_applied_paise, payable_paise,
            razorpay_order_id, payment_status, status
       FROM orders.orders WHERE cart_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [cartId]
  )
  return rows.length ? shape(rows[0]) : null
}

function shape(r: any): PlacedOrder {
  return {
    id: r.id,
    displayId: r.display_id,
    subtotalPaise: r.subtotal_paise,
    creditAppliedPaise: r.credit_applied_paise,
    payablePaise: r.payable_paise,
    razorpayOrderId: r.razorpay_order_id,
    paymentStatus: r.payment_status,
    status: r.status,
  }
}
