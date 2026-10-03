import { getOrdersDbPool } from "./db"
import { getCart, type Brand, type Cart } from "./cart"
import { createRazorpayOrder, verifyPaid } from "./razorpay"
import { releaseCartCredit } from "../wallet/cart-credit"
import { getEffectiveConfig } from "../wallet/reward-config"
import { notifyOrderStatusDetached } from "./notify"

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

export type PaymentMethod = "razorpay" | "cod"

export interface PlacedOrder {
  id: string
  paymentMethod?: PaymentMethod
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
  /** Defaults to prepaid. "cod" is refused unless the brand's fulfilment config allows it. */
  paymentMethod?: PaymentMethod
}): Promise<{ order: PlacedOrder; cart: Cart }> {
  const paymentMethod: PaymentMethod = input.paymentMethod === "cod" ? "cod" : "razorpay"
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
  /**
   * Cash on delivery, only where the brand allows it.
   *
   * Checked against the config rather than hard-coded by brand, because which brands offer it is a
   * business decision — and checked on the SERVER because "cod" arriving in a request body is
   * otherwise a way to place a CrossFriend order that skips payment entirely. A cake is made before
   * it travels; a refused delivery is a total loss rather than a return to stock, which is exactly
   * why CrossFriend has it switched off.
   */
  if (paymentMethod === "cod") {
    const config = await getEffectiveConfig(cart.brand, cart.pincode, "fulfilment")
    if (!config?.params.cod_enabled) {
      throw new OrderError("cod_not_offered", "Cash on delivery is not available for this order.")
    }
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
          credit_applied_paise, payable_paise, address, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, display_id, subtotal_paise, credit_applied_paise, payable_paise,
                 razorpay_order_id, payment_status, status, payment_method`,
      [
        input.cartId,
        input.customerId,
        cart.brand,
        cart.subtotalPaise,
        cart.deliveryPaise,
        cart.creditAppliedPaise,
        cart.payablePaise,
        JSON.stringify(input.address),
        paymentMethod,
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
    await recordEvent(
      client,
      order.id,
      "placed",
      "system",
      paymentMethod === "cod" ? "Order placed, to be paid on delivery" : "Order placed, awaiting payment"
    )

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }

  /**
   * A cash order is finished here.
   *
   * No gateway, no payment to wait on, and the database refuses a razorpay_order_id on it. The money
   * arrives at the door, which is why OPS marking it delivered is what moves it to paid.
   */
  if (paymentMethod === "cod") {
    return { order, cart }
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

    /**
     * Told after the money is committed, never before, and never awaited.
     *
     * After the COMMIT because a text saying "payment confirmed" must not be able to go out ahead of
     * a transaction that then rolls back. Not awaited because this is also the webhook's response
     * path — Razorpay retries anything slow, and an 8-second SMS timeout inside it would turn one
     * confirmed payment into a stream of duplicate deliveries.
     */
    notifyOrderStatusDetached({ orderId: order.id, status: "paid" })

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
    paymentMethod: r.payment_method,
  }
}

/**
 * Give back credit on orders nobody paid for.
 *
 * ── The hole this closes ───────────────────────────────────────────────────────────────────────
 * Credit leaves the wallet the moment a customer applies it at the cart, because the amount they
 * are charged drops at that moment and the two have to agree. release-abandoned-cart-credit gives
 * it back when a cart never becomes an order. Nothing gave it back when the cart DID become an
 * order and the order was never paid — the customer closed the tab, the payment failed, they
 * changed their mind — and the redemption simply stood for ever.
 *
 * Found in production with a real balance: a ₹100 signup bonus consumed by two orders that were
 * placed and never paid, leaving the customer at zero with nothing on any screen explaining where
 * their money went.
 *
 * ── Why it cancels rather than just refunding the credit ───────────────────────────────────────
 * Because payable_paise is subtotal + delivery − credit, enforced by orders_totals_ck, and a
 * Razorpay order was created for that figure. Returning the credit while leaving the order open
 * would leave an order whose total no longer matches what the customer can pay, and the constraint
 * would refuse the update anyway. An order that has been unpaid this long is not a live order, so
 * it is closed and the money returned together.
 *
 * ── What it will never touch ───────────────────────────────────────────────────────────────────
 * Anything paid. The guard is on payment_status, not on elapsed time, because a slow UPI collect
 * that lands after the cutoff must not have its order cancelled underneath it — markOrderPaid is
 * the authority on whether money arrived, and it always asks Razorpay.
 */
export async function cancelAbandonedOrders(input: {
  olderThanHours?: number
  at?: Date
} = {}): Promise<{ orders: number; releasedPaise: number }> {
  const hours = input.olderThanHours ?? 24
  const at = input.at ?? new Date()
  const db = getOrdersDbPool()

  const { rows } = await db.query(
    `SELECT id, display_id, cart_id, credit_applied_paise
       FROM orders.orders
      WHERE payment_status = 'awaiting'
        AND status = 'placed'
        AND created_at < $1::timestamptz - ($2 || ' hours')::interval`,
    [at, String(hours)]
  )

  let releasedPaise = 0
  let orders = 0

  for (const order of rows) {
    /* One order's failure must not strand every later one, so each is handled on its own. */
    try {
      /**
       * Re-checked inside the loop against the live row, not the snapshot above.
       *
       * The webhook runs concurrently with this job. An order that was awaiting when the query ran
       * can be paid by the time its turn comes, and cancelling it then would take the credit back
       * off an order the customer has actually paid for. The UPDATE carries the condition itself,
       * so the database decides rather than this process.
       */
      const { rowCount } = await db.query(
        `UPDATE orders.orders
            SET status = 'cancelled', updated_at = NOW()
          WHERE id = $1::uuid AND payment_status = 'awaiting' AND status = 'placed'`,
        [order.id]
      )
      if (!rowCount) continue

      if (Number(order.credit_applied_paise) > 0 && order.cart_id) {
        const { releasedPaise: back } = await releaseCartCredit({
          cartId: String(order.cart_id),
          reason: `Order #${order.display_id} was not paid — credit returned`,
        })
        releasedPaise += back
      }

      await recordEvent(
        db,
        order.id,
        "cancelled",
        "system",
        "Not paid — order closed and any credit returned"
      )
      orders += 1
    } catch (error) {
      console.error(
        `[orders] could not close unpaid order ${order.id}: ` +
          (error instanceof Error ? error.message : String(error))
      )
    }
  }

  return { orders, releasedPaise }
}
