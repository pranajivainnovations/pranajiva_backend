import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getOrder, markOrderPaid } from "../../../../services/orders/order"
import { verifySignature } from "../../../../services/orders/razorpay"

/**
 * POST /store/checkout/confirm — the browser came back.
 *
 * ── Why this is optional, and says so ──────────────────────────────────────────────────────────
 * The webhook confirms the same order independently. This route exists so a customer who is still
 * looking at the page gets their confirmation in a second rather than whenever Razorpay's delivery
 * arrives. If it never runs — tab closed, signal lost — nothing is lost: the order already exists
 * and the webhook will move it.
 *
 * That is the whole reason the page no longer has to say "do not close this window".
 *
 * ── Why a signature here is not enough ─────────────────────────────────────────────────────────
 * The values in this request came from the browser, and a browser can be edited. The signature
 * proves Razorpay produced them, which is worth checking — but `markOrderPaid` asks Razorpay
 * directly regardless, because a valid signature on a failed payment is still a valid signature.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({ error: "Sign in to see your order.", code: "AUTH_REQUIRED" })
    return
  }

  const body = (req.body ?? {}) as {
    order_id?: string
    razorpay_order_id?: string
    razorpay_payment_id?: string
    razorpay_signature?: string
  }

  if (!body.razorpay_order_id) {
    res.status(400).json({ error: "razorpay_order_id is required.", code: "missing_reference" })
    return
  }

  /* Checked and reported, never depended on. A mismatch is logged because it is the shape a forged
     callback would take, and it is worth knowing if one ever arrives. */
  const signatureOk =
    !!body.razorpay_payment_id &&
    !!body.razorpay_signature &&
    verifySignature({
      razorpayOrderId: body.razorpay_order_id,
      razorpayPaymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    })

  if (!signatureOk) {
    console.warn(
      `[store/checkout/confirm] signature did not verify for ${body.razorpay_order_id} ` +
        `(customer ${customerId}) — asking Razorpay directly`
    )
  }

  try {
    const result = await markOrderPaid({
      razorpayOrderId: body.razorpay_order_id,
      razorpayPaymentId: body.razorpay_payment_id ?? null,
      actor: `customer:${customerId}`,
    })

    if (!result.orderId) {
      res.status(404).json({ error: "We could not find that order.", code: "unknown_order" })
      return
    }

    const order = await getOrder(result.orderId)

    /**
     * Paid is paid, whether this call did it or the webhook got here first. `already_paid` is the
     * ordinary outcome of running both paths, not an error, and the customer must never see it as
     * one.
     */
    if (order?.paymentStatus === "paid") {
      res.status(200).json({
        confirmed: true,
        order: { id: order.id, display_id: order.displayId },
      })
      return
    }

    /**
     * Razorpay does not agree it is paid.
     *
     * Deliberately not an error the customer can act on by paying again — the order exists, and if
     * money did move the webhook will confirm it shortly. Telling them to retry here is how a
     * second charge happens.
     */
    res.status(202).json({
      confirmed: false,
      pending: true,
      reason: result.reason,
      order: order ? { id: order.id, display_id: order.displayId } : null,
      message:
        "We have your order and are confirming the payment. You will get a message shortly — there is no need to pay again.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[store/checkout/confirm] ${body.razorpay_order_id}: ${message}`)
    /* Same wording as above on purpose: from the customer's side this is the same situation, and
       the recovery — wait for the webhook — is identical. */
    res.status(202).json({
      confirmed: false,
      pending: true,
      message:
        "We have your order and are confirming the payment. You will get a message shortly — there is no need to pay again.",
    })
  }
}
