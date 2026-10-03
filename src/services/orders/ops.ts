import { getOrdersDbPool } from "./db"
import { recordEvent } from "./order"
import { notifyOrderStatusDetached } from "./notify"
import { onOrderCancelledDetached, onOrderPaidDetached } from "./growth"

/**
 * What ops needs to run an order.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────────
 * The checkout was rebuilt onto orders.orders and nothing could see what it produced. OPS's orders
 * screen queries public."order" — Medusa's table — so every order placed through the new pipeline
 * landed somewhere no screen looked. The pipeline worked and the business could not operate it.
 *
 * ── Why a baker is assigned per ITEM, not per order ────────────────────────────────────────────
 * baker_id sits on orders.order_items. One cart can hold a custom cake and a ready-to-deliver box
 * that come from different kitchens, and forcing a single baker onto the order would either split
 * the order or lie about who is making what. Assigning all items at once is the common case and is
 * what the route does when no item ids are given — but it is a convenience, not the model.
 *
 * ── Why there is no read here ──────────────────────────────────────────────────────────────────
 * OPS queries the database directly for everything it displays, as every other OPS screen does: it
 * sits beside the database and a round trip through this service would be a slower copy of a query
 * that can then drift from the one on the page. What lives here is the WRITES — where the rules,
 * the validation and the attribution belong, and where a screen must not be trusted.
 *
 * ── Why status moves are attributed and recorded ───────────────────────────────────────────────
 * orders.order_events is append-only and it is the only record of who moved an order and when. The
 * customer's confirmation page reads the same rows, so an event written here is also the sentence
 * the customer sees. There is no "quiet" status change.
 */

export type OrderStatus =
  | "placed"
  | "accepted"
  | "making"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"

/**
 * What may follow what.
 *
 * Forward one step at a time, and cancelled from anywhere that has not been delivered. Deliberately
 * not a free-for-all: the confirmation page draws a progress rail from these, and an order that
 * jumps from placed to delivered produces a timeline that cannot be read. Ops can still cancel at
 * any point, because that is the correction that actually comes up.
 */
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  placed: ["accepted", "cancelled"],
  accepted: ["making", "cancelled"],
  making: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
}

export class OpsOrderError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = "OpsOrderError"
  }
}

/**
 * Hand items to a baker.
 *
 * ── Why the baker is checked, not trusted ──────────────────────────────────────────────────────
 * An id arriving from a screen is a value somebody could get wrong, and an order assigned to a
 * baker who is not onboarded is an order nobody is making. The same rule the customer-facing finder
 * applies — active and onboarded — applies here, so ops cannot hand work to a bakery the storefront
 * would not have offered in the first place.
 */
export async function assignBaker(input: {
  orderId: string
  bakerId: string
  itemIds?: string[]
  opsUserId: string
}): Promise<{ assigned: number; bakerName: string }> {
  const db = getOrdersDbPool()

  const { rows: bakers } = await db.query(
    `SELECT id, name FROM baker_network.bakers
      WHERE id = $1::uuid AND is_active AND status = 'onboarded'`,
    [input.bakerId]
  )
  if (!bakers.length) {
    throw new OpsOrderError(
      "baker_not_available",
      "That baker is not onboarded and active, so they cannot be given work.",
      404
    )
  }

  const { rows: orders } = await db.query(
    `SELECT id, status FROM orders.orders WHERE id = $1::uuid`,
    [input.orderId]
  )
  if (!orders.length) throw new OpsOrderError("not_found", "No such order.", 404)
  if (orders[0].status === "cancelled") {
    throw new OpsOrderError("cancelled", "That order is cancelled.", 409)
  }

  /* No item ids means every item on the order — the common case, and the one ops will use most. */
  const { rowCount } = input.itemIds?.length
    ? await db.query(
        `UPDATE orders.order_items SET baker_id = $1
          WHERE order_id = $2::uuid AND id = ANY($3::uuid[])`,
        [input.bakerId, input.orderId, input.itemIds]
      )
    : await db.query(
        `UPDATE orders.order_items SET baker_id = $1 WHERE order_id = $2::uuid`,
        [input.bakerId, input.orderId]
      )

  await recordEvent(
    db,
    input.orderId,
    orders[0].status,
    input.opsUserId,
    `Assigned to ${bakers[0].name}`
  )

  return { assigned: rowCount ?? 0, bakerName: bakers[0].name }
}

/**
 * Move an order along.
 *
 * ── Why accepting needs a baker ────────────────────────────────────────────────────────────────
 * "Accepted" is the step the customer reads as *a baker has taken this on*, and the confirmation
 * page labels it "Baker assigned". Letting it move with every item unassigned would put a sentence
 * on a customer's screen that is not true yet, which is the whole class of problem this rebuild was
 * meant to end.
 *
 * ── Why payment is not a gate ──────────────────────────────────────────────────────────────────
 * Deliberately. A UPI collect can settle minutes after the order exists, and ops watching an order
 * they know is good should not be blocked by a webhook that has not landed. The payment status is
 * shown beside the order instead, so the decision is informed rather than prevented.
 */
export async function moveOrderStatus(input: {
  orderId: string
  next: OrderStatus
  opsUserId: string
  note?: string | null
}): Promise<{ from: string; to: string }> {
  const db = getOrdersDbPool()

  const { rows } = await db.query(
    `SELECT o.id, o.status, o.payment_method, o.payment_status,
            (SELECT count(*)::int FROM orders.order_items i
              WHERE i.order_id = o.id AND i.baker_id IS NULL) AS unassigned
       FROM orders.orders o WHERE o.id = $1::uuid`,
    [input.orderId]
  )
  if (!rows.length) throw new OpsOrderError("not_found", "No such order.", 404)

  const from = rows[0].status as OrderStatus
  const allowed = NEXT[from] ?? []

  if (!allowed.includes(input.next)) {
    throw new OpsOrderError(
      "bad_transition",
      allowed.length
        ? `An order that is ${from} can only move to ${allowed.join(" or ")}.`
        : `An order that is ${from} cannot be moved again.`,
      409
    )
  }

  if (input.next === "accepted" && rows[0].unassigned > 0) {
    throw new OpsOrderError(
      "no_baker",
      "Assign a baker before accepting — the customer is told a baker has taken this on.",
      409
    )
  }

  /**
   * Delivering a cash order is also collecting the money.
   *
   * For COD there is no gateway and no webhook — the payment happens at the door, and the only
   * moment anybody learns it happened is when the order is marked delivered. Doing it in the same
   * UPDATE rather than a second statement means an order cannot end up delivered but unpaid because
   * the process died between the two.
   *
   * Only from `awaiting`: a cash order somebody already reconciled by hand must not be re-marked,
   * and a prepaid order's payment is Razorpay's to confirm, never this screen's.
   */
  const collectsCash =
    input.next === "delivered" &&
    rows[0].payment_method === "cod" &&
    rows[0].payment_status === "awaiting"

  /* The condition travels with the UPDATE so two ops users pressing at once cannot both win. */
  const { rowCount } = await db.query(
    collectsCash
      ? `UPDATE orders.orders
            SET status = $1, payment_status = 'paid', updated_at = NOW()
          WHERE id = $2::uuid AND status = $3 AND payment_status = 'awaiting'`
      : `UPDATE orders.orders SET status = $1, updated_at = NOW()
          WHERE id = $2::uuid AND status = $3`,
    [input.next, input.orderId, from]
  )
  if (!rowCount) {
    throw new OpsOrderError("changed", "Somebody else moved that order. Reload and try again.", 409)
  }

  await recordEvent(db, input.orderId, input.next, input.opsUserId, input.note ?? undefined)

  /**
   * The customer hears about it, if there is an approved template for this status.
   *
   * Detached on purpose: this sits inside an ops user's button press and MSG91's timeout is eight
   * seconds. A courtesy must not be able to make the screen feel broken, and the move has already
   * happened by the time this runs — the order is the fact, the text is the kindness.
   */
  if (collectsCash) {
    await recordEvent(db, input.orderId, input.next, input.opsUserId, "Cash collected on delivery")
    notifyOrderStatusDetached({ orderId: input.orderId, status: "paid" })
    /* A cash order earns joining cash at the door, which is the moment it becomes paid. Whether it
       QUALIFIES is a separate question the mechanic answers — prepaid_only exists precisely to say
       cash does not count, and that decision belongs there rather than in a condition here. */
    onOrderPaidDetached(input.orderId)
  }

  /* A cancelled order takes back what it earned — the wallet decides reclaim or write-off. */
  if (input.next === "cancelled") onOrderCancelledDetached(input.orderId)

  notifyOrderStatusDetached({ orderId: input.orderId, status: input.next })

  return { from, to: input.next }
}
