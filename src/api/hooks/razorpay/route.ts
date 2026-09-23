import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { markOrderPaid } from "../../../services/orders/order"
import { verifyWebhookSignature } from "../../../services/orders/razorpay"

/**
 * POST /hooks/razorpay — Razorpay telling us what happened.
 *
 * ── What this is for ───────────────────────────────────────────────────────────────────────────
 * The case the whole pipeline was rebuilt around: the customer paid and their browser never came
 * back. Tab closed, connection dropped, phone rang — or they used UPI collect and approved it four
 * minutes later in a different app. Before this route existed, confirmation depended entirely on the
 * browser returning, which is why checkouts everywhere beg you not to close the page.
 *
 * Here the order already exists in `awaiting`. This arrives and moves it to `paid`, whether or not
 * anybody is looking at a screen.
 *
 * ── Why it always answers 200 ──────────────────────────────────────────────────────────────────
 * Razorpay retries a non-2xx for hours and disables an endpoint that keeps failing. An event we
 * cannot use — for an order we do not have, or one already paid — is not a failure on their side and
 * must not be reported as one. Anything genuinely wrong is logged, where it can be found, rather
 * than thrown back at a delivery service that will simply send it again.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const raw = (req as any).rawBody as string | undefined
  const signature = req.headers["x-razorpay-signature"] as string | undefined

  /* The cheap filter. Not the authority — markOrderPaid asks Razorpay directly regardless — so a
     missing secret or an unparseable body degrades to a slower path, never to a wrong answer. */
  const signatureOk = raw ? verifyWebhookSignature(raw, signature ?? "") : false
  if (!signatureOk) {
    console.warn(
      `[hooks/razorpay] signature not verified (raw body ${raw ? "present" : "missing"}, ` +
        `secret ${process.env.RAZORPAY_WEBHOOK_SECRET ? "set" : "UNSET"}) — verifying with Razorpay instead`
    )
  }

  let event: any = null
  try {
    event = raw ? JSON.parse(raw) : req.body
  } catch {
    console.error("[hooks/razorpay] body was not JSON")
    res.status(200).json({ received: true, handled: false, reason: "unparseable" })
    return
  }

  /**
   * The order id, from wherever this event shape keeps it.
   *
   * `order.paid` carries the order directly; `payment.captured` carries a payment that points at
   * one. Both are worth handling — the second arrives first in practice, and waiting for the
   * tidier event costs the customer their confirmation.
   */
  const razorpayOrderId: string | undefined =
    event?.payload?.order?.entity?.id ?? event?.payload?.payment?.entity?.order_id
  const razorpayPaymentId: string | undefined = event?.payload?.payment?.entity?.id

  if (!razorpayOrderId) {
    res.status(200).json({ received: true, handled: false, reason: "no_order_in_event" })
    return
  }

  try {
    const result = await markOrderPaid({
      razorpayOrderId,
      razorpayPaymentId: razorpayPaymentId ?? null,
      actor: "webhook",
    })

    if (result.changed) {
      console.log(`[hooks/razorpay] ${event?.event} confirmed order ${result.orderId}`)
    }

    res.status(200).json({ received: true, handled: result.changed, reason: result.reason })
  } catch (error) {
    /* Logged and acknowledged. A retry would hit the same error, and the order can still be
       confirmed by the browser's path or by hand — neither of which a 500 here helps. */
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[hooks/razorpay] failed on ${razorpayOrderId}: ${message}`)
    res.status(200).json({ received: true, handled: false, reason: "error_logged" })
  }
}
