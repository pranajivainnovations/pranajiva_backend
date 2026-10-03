import { getOrdersDbPool } from "./db"
import { evaluateJoiningCash, isNotGranted, issueJoiningCash } from "../wallet/joining-cash"
import { clawbackOrderRewards } from "../wallet/sweeper"
import type { Brand } from "./cart"

/**
 * What an order owes the customer who placed it.
 *
 * ── Why this file exists ───────────────────────────────────────────────────────────────────────
 * Joining cash was wired to Medusa through a subscriber on `OrderService.Events.PLACED`. When
 * ordering moved to orders.orders that event stopped happening, and nothing replaced it — so from
 * the cutover a first order earned nobody anything, silently, with the whole mechanism still built
 * and working behind it. Nobody noticed because no real order has been placed since.
 *
 * ── Why it fires on PAID rather than on placed ─────────────────────────────────────────────────
 * The Medusa subscriber ran at placement and worked out separately whether the order was prepaid,
 * because in Medusa an order exists only once payment has been authorised. Here an order exists
 * before any money moves, so "placed" means nothing has been paid yet — and granting joining cash
 * there would hand credit to anybody who reached the checkout and walked away.
 *
 * Paid is also the one moment that is identical for both payment methods. A card order becomes paid
 * when Razorpay confirms it; a cash order becomes paid when ops marks it delivered. Hooking the
 * state rather than the method means cash on delivery needed no special case here at all.
 *
 * ── Why nothing here can break an order ────────────────────────────────────────────────────────
 * Every path returns a reason instead of throwing, and callers do not await a result they act on.
 * A grant that fails is money we owe and can pay later; an order that fails because a grant did is
 * a customer who did not get their cake.
 */

export type GrantOutcome =
  | { granted: false; reason: string }
  | { granted: true; which: number; amountPaise: number }

/** Medusa's sales channel names map to brands; ours carries the brand on the order itself. */
function brandOf(value: string | null | undefined): Brand {
  return value === "pranajiva" ? "pranajiva" : "crossfriend"
}

/**
 * Settle what a newly paid order earns.
 *
 * Idempotent through the ledger rather than through a flag here: joining cash is written with the
 * order id on it and a unique index refuses a second grant of the same type for the same order. So
 * a webhook and a browser callback both arriving, or ops correcting a delivery twice, costs one
 * wasted query and grants nothing extra.
 */
export async function onOrderPaid(orderId: string): Promise<GrantOutcome> {
  try {
    const { rows } = await getOrdersDbPool().query(
      `SELECT id, customer_id, brand, payable_paise, subtotal_paise, delivery_paise,
              payment_method, address
         FROM orders.orders
        WHERE id = $1::uuid`,
      [orderId]
    )
    if (!rows.length) return { granted: false, reason: "no_such_order" }

    const order = rows[0]
    /* A guest order has nobody to credit. Nothing is wrong; there is simply no wallet. */
    if (!order.customer_id) return { granted: false, reason: "guest" }

    const address = (order.address ?? {}) as Record<string, string>

    const outcome = await issueJoiningCash({
      customerId: order.customer_id,
      orderId: order.id,
      brand: brandOf(order.brand),
      pincode: address.postal_code ?? null,
      /**
       * What the customer paid, delivery included.
       *
       * The minimum order is a figure somebody recognises from their own basket, and a ₹699 minimum
       * that silently meant ₹699-before-delivery would refuse a customer who saw ₹720 on their
       * screen and would be right to complain. Referral commission takes the opposite view for a
       * different reason — see referral-payout.
       */
      totalPaise: Number(order.subtotal_paise ?? 0) + Number(order.delivery_paise ?? 0),
      /**
       * Paid before it shipped, or paid at the door.
       *
       * This is called only when an order has become paid, so both are true in the ordinary sense —
       * but `prepaid_only` exists to exclude cash, where the money arrives after the cost has been
       * incurred and a refused delivery is a total loss. So the method is what answers it, not the
       * status that got us here.
       */
      isPrepaid: order.payment_method !== "cod",
      shippingAddress: address.address_1
        ? {
            line1: address.address_1,
            line2: address.address_2 ?? null,
            city: address.city,
            postalCode: address.postal_code,
          }
        : null,
    })

    if (isNotGranted(outcome)) {
      return { granted: false, reason: outcome.reason }
    }

    console.log(
      `[orders/growth] order ${order.id}: joining cash ${outcome.which} of 2, ` +
        `₹${(outcome.amountPaise / 100).toFixed(2)}`
    )
    return { granted: true, which: outcome.which, amountPaise: outcome.amountPaise }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[orders/growth] joining cash failed for order ${orderId}: ${detail}`)
    return { granted: false, reason: "error" }
  }
}

/**
 * Take back what a cancelled order earned.
 *
 * ── Why this is not simply the opposite of onOrderPaid ─────────────────────────────────────────
 * It is a policy question, not an arithmetic one, and the policy lives in the wallet: whether a
 * grant is reclaimed, written off, or left alone depends on whether the customer has already spent
 * it. clawbackOrderRewards owns that and keys on the order id, which is why it needed no change for
 * our orders — only somebody to call it, since the Medusa CANCELED event it listened for no longer
 * happens.
 *
 * Reversing a redemption is a different matter and deliberately not done here: credit the customer
 * SPENT on a cancelled order is returned by the order service when it closes the order, because
 * that is their money rather than a reward.
 */
export async function onOrderCancelled(orderId: string): Promise<void> {
  try {
    const result = await clawbackOrderRewards(orderId)
    if (result.grantsReversed > 0) {
      console.log(
        `[orders/growth] order ${orderId} cancelled: reversed ${result.grantsReversed} grant(s), ` +
          `₹${(result.paiseReclaimed / 100).toFixed(2)} reclaimed` +
          (result.paiseWrittenOff > 0
            ? `, ₹${(result.paiseWrittenOff / 100).toFixed(2)} written off (already spent)`
            : "")
      )
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[orders/growth] clawback failed for order ${orderId}: ${detail}`)
  }
}

export function onOrderCancelledDetached(orderId: string): void {
  void onOrderCancelled(orderId).catch(() => {
    /* onOrderCancelled already logs. */
  })
}

/** Fire and forget, for callers whose own job must not wait on a grant. */
export function onOrderPaidDetached(orderId: string): void {
  void onOrderPaid(orderId).catch(() => {
    /* onOrderPaid already logs; this only stops an unhandled rejection. */
  })
}

/**
 * What an order WOULD earn, without granting it.
 *
 * For OPS and for tests: the same decision, with its reasoning, and nothing written. Useful when
 * somebody asks why a particular customer did not get joining cash they expected.
 */
export async function previewOrderGrant(orderId: string) {
  const { rows } = await getOrdersDbPool().query(
    `SELECT id, customer_id, brand, subtotal_paise, delivery_paise, payment_method, address
       FROM orders.orders WHERE id = $1::uuid`,
    [orderId]
  )
  if (!rows.length) return null

  const order = rows[0]
  if (!order.customer_id) return null
  const address = (order.address ?? {}) as Record<string, string>

  return evaluateJoiningCash({
    customerId: order.customer_id,
    orderId: order.id,
    brand: brandOf(order.brand),
    pincode: address.postal_code ?? null,
    totalPaise: Number(order.subtotal_paise ?? 0) + Number(order.delivery_paise ?? 0),
    isPrepaid: order.payment_method !== "cod",
    shippingAddress: address.address_1
      ? {
          line1: address.address_1,
          line2: address.address_2 ?? null,
          city: address.city,
          postalCode: address.postal_code,
        }
      : null,
  })
}
