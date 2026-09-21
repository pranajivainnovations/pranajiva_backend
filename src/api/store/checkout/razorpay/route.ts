import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

/**
 * The one place that knows how a Razorpay payment is set up.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────────────────────────
 * Two storefronts pay through the same gateway. Before this route, each of them independently
 * created payment sessions, picked the Razorpay one, dug the order id out of `session.data`, read a
 * publishable key out of its own build-time environment, and guessed what to do when any of that
 * came back empty. Four decisions, made twice, in two codebases that ship separately — so they
 * could drift, and did: only one of them had the key configured at all.
 *
 * Everything that decides what is paid now happens here, once. A storefront asks for a cart's
 * payment context and receives the key, the order and the amount already settled. What is left in
 * the browser is opening Razorpay's modal, which is presentation.
 *
 * ── Why the preflight is the substance of this route ───────────────────────────────────────────
 * medusa-payment-razorpay fails *quietly*. `initiatePayment` creates a Razorpay customer before it
 * creates the order, and if that customer cannot be created — no cart customer, no email, no phone
 * on the billing address — it logs a line and returns a session with no order in it. Nothing
 * throws. The storefront is handed an empty session and has to invent an explanation, which is how
 * both of them ended up saying "card payment is not configured" for what is really a missing phone
 * number.
 *
 * Worse is `updatePayment`: it returns early when the cart has no billing address, so the Razorpay
 * order is never rebuilt when the total changes. A customer who applied wallet credit after opening
 * checkout could be shown the old, higher amount — and pay it.
 *
 * So this route checks those preconditions before asking for a session, copies the shipping address
 * into the billing slot when the billing slot is empty (which is what makes updatePayment run at
 * all), and then verifies the session it got back actually contains an order for the amount the
 * cart currently owes. If it does not, it refuses and says which precondition failed, rather than
 * opening a payment window onto a number nobody checked.
 *
 * ── What is deliberately not here ──────────────────────────────────────────────────────────────
 * Completing the order. Medusa owns that, and its completion is what asks Razorpay whether the
 * order was really paid. Adding a second completion path here would mean two things that can create
 * an order and only one of them verified.
 */

/** Razorpay's publishable key. Public by design — checkout.js takes it in the browser. */
function resolveKeyId(): string {
  return String(process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_ID || "")
}

type RazorpaySessionData = {
  id?: string
  amount?: number
  currency?: string
  status?: string
}

/** Everything the browser needs to open the modal, and nothing it could use to change the price. */
type PaymentContext = {
  key_id: string
  order_id: string
  amount: number
  currency: string
  prefill: { name?: string; email?: string; contact?: string }
  notes: Record<string, string>
}

type Refusal = { status: number; code: string; error: string }

const CART_RELATIONS = [
  "items",
  "region",
  "shipping_address",
  "billing_address",
  "shipping_methods",
  "payment_sessions",
  "customer",
]

/**
 * POST /store/checkout/razorpay — prepare a cart for payment and describe how to pay it.
 *
 * Body: { cart_id: string }
 *
 * 200 { context }                  ready to open the modal
 * 200 { completed: true, order }   already paid and completed; nothing left to do
 * 4xx { code, error }              a named precondition, in words a customer can act on
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const cartId = (req.body as { cart_id?: string })?.cart_id

  if (!cartId) {
    res.status(400).json({ code: "cart_id_required", error: "cart_id is required" })
    return
  }

  const keyId = resolveKeyId()
  if (!keyId.startsWith("rzp_")) {
    /* A deploy problem, not a customer problem: no amount of retrying fixes an unset key, so say so
       in a way that sends them to us rather than back round the same loop. */
    res.status(503).json({
      code: "gateway_unconfigured",
      error: "Card payment is unavailable right now. Please contact us to complete your order.",
    })
    return
  }

  const cartService = req.scope.resolve("cartService") as any

  try {
    let cart = await cartService.retrieveWithTotals(cartId, { relations: CART_RELATIONS })

    /**
     * Already done. Reached by a customer who paid, lost the confirmation — a closed tab, a dropped
     * connection — and came back. The order exists; the honest answer is to say so rather than
     * charge them a second time.
     */
    if (cart.completed_at) {
      res.status(200).json({ completed: true, ...(await orderSummary(req, cartId)) })
      return
    }

    const refusal = checkPreconditions(cart)
    if (refusal) {
      res.status(refusal.status).json({ code: refusal.code, error: refusal.error })
      return
    }

    /**
     * Fill the billing address from the shipping address when it is missing.
     *
     * This is not tidiness. The plugin reads the phone number off `cart.billing_address` to create
     * its Razorpay customer, and skips refreshing the order entirely when that address is absent.
     * Both storefronts collect one address and never set the billing one, so without this line the
     * common path is the broken path.
     */
    if (!cart.billing_address_id && cart.shipping_address) {
      const { id: _id, created_at: _c, updated_at: _u, ...billing } = cart.shipping_address as any
      await cartService.update(cartId, { billing_address: billing })
    }

    /* One call does both: creates any missing sessions and refreshes the existing ones against the
       current total, which is what rebuilds a stale Razorpay order. */
    await cartService.setPaymentSessions(cartId)
    await cartService.setPaymentSession(cartId, "razorpay")

    cart = await cartService.retrieveWithTotals(cartId, { relations: CART_RELATIONS })

    const session = (cart.payment_sessions ?? []).find(
      (s: { provider_id: string }) => s.provider_id === "razorpay"
    )
    const data = (session?.data ?? {}) as RazorpaySessionData

    if (!session || !data.id) {
      /**
       * The quiet failure described at the top of this file. Every precondition we know about
       * passed, so rather than repeat a guess, log what the session actually contained — that log
       * line is the only evidence of why the plugin gave up.
       */
      console.error(
        `[store/checkout/razorpay] no Razorpay order in session for cart ${cartId};`,
        `session=${session ? JSON.stringify(session.data) : "absent"}`
      )
      res.status(502).json({
        code: "no_payment_order",
        error:
          "We could not start the payment. Please check your phone number and email, then try again.",
      })
      return
    }

    /**
     * The amount the customer is about to be shown, against the amount the cart says they owe.
     *
     * They can differ: the plugin declines to refresh its order under conditions it does not report,
     * and wallet credit applied mid-checkout changes the total. Charging the stale figure would take
     * real money for a number nothing had checked, so a mismatch refuses here instead.
     */
    if (typeof data.amount === "number" && data.amount !== cart.total) {
      console.error(
        `[store/checkout/razorpay] stale amount for cart ${cartId}:`,
        `session=${data.amount} cart=${cart.total}`
      )
      res.status(409).json({
        code: "amount_changed",
        error: "Your order total changed. Please review your cart and try again.",
      })
      return
    }

    const address = cart.billing_address ?? cart.shipping_address
    const context: PaymentContext = {
      key_id: keyId,
      order_id: data.id,
      amount: data.amount ?? cart.total,
      currency: (data.currency ?? cart.region?.currency_code ?? "INR").toUpperCase(),
      prefill: {
        name: [address?.first_name, address?.last_name].filter(Boolean).join(" ") || undefined,
        email: cart.email ?? undefined,
        contact: address?.phone ?? undefined,
      },
      notes: { cart_id: cartId },
    }

    res.status(200).json({ context })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[store/checkout/razorpay] cart ${cartId}:`, message)
    res.status(500).json({
      code: "unexpected",
      error: "Something went wrong starting the payment. Please try again.",
    })
  }
}

/**
 * GET /store/checkout/razorpay?cart_id=… — did that payment actually go through?
 *
 * The question worth answering after the worst failure this flow has: the customer paid, and the
 * call that turns payment into an order did not come back. They have been debited and have no
 * confirmation, and the only thing they can see is an error.
 *
 * Read-only on purpose. It reports whether the cart became an order; it cannot make one. Completion
 * stays with Medusa, where the payment is actually verified — a recovery path that could create
 * orders would be a second, unverified way to get one.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const cartId = typeof req.query.cart_id === "string" ? req.query.cart_id : null

  if (!cartId) {
    res.status(400).json({ code: "cart_id_required", error: "cart_id is required" })
    return
  }

  try {
    const cartService = req.scope.resolve("cartService") as any
    const cart = await cartService.retrieve(cartId, { select: ["id", "completed_at"] })

    if (!cart.completed_at) {
      res.status(200).json({ completed: false })
      return
    }

    res.status(200).json({ completed: true, ...(await orderSummary(req, cartId)) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[store/checkout/razorpay GET] cart ${cartId}:`, message)
    res.status(500).json({ code: "unexpected", error: "Could not check that order." })
  }
}

/** The order a completed cart became, reduced to what a confirmation screen needs. */
async function orderSummary(req: MedusaRequest, cartId: string) {
  try {
    const orderService = req.scope.resolve("orderService") as any
    const order = await orderService.retrieveByCartId(cartId, { select: ["id", "display_id"] })
    return { order: { id: order.id, display_id: order.display_id } }
  } catch {
    /* Completed but the order could not be read. Still a truthful "yes, it went through" — the
       storefront shows a confirmation without a number rather than an error. */
    return { order: null }
  }
}

/**
 * The conditions the plugin needs met, checked before it can fail quietly on any of them.
 *
 * Each refusal names one thing and says what to do about it, because the customer is at a payment
 * screen and "please try again" is only useful when trying again would change something.
 */
function checkPreconditions(cart: any): Refusal | null {
  if (!cart.items?.length) {
    return { status: 400, code: "empty_cart", error: "Your cart is empty." }
  }
  if (!cart.region_id) {
    return {
      status: 400,
      code: "no_region",
      error: "We could not work out delivery for this order. Please start checkout again.",
    }
  }
  if (!cart.email) {
    return { status: 400, code: "no_email", error: "Please add an email address to continue." }
  }
  if (!cart.shipping_address) {
    return {
      status: 400,
      code: "no_address",
      error: "Please add a delivery address to continue.",
    }
  }
  /* Razorpay will not create a customer without one, and the plugin turns that into an empty
     session rather than an error. Asking for it here is the difference between a fixable message
     and a dead end. */
  const phone = cart.billing_address?.phone ?? cart.shipping_address?.phone ?? cart.customer?.phone
  if (!phone) {
    return {
      status: 400,
      code: "no_phone",
      error: "Please add a phone number to continue — the payment provider requires one.",
    }
  }
  if (!cart.customer_id) {
    return {
      status: 400,
      code: "no_customer",
      error: "Please sign in or add your details to continue.",
    }
  }
  if (!cart.total || cart.total <= 0) {
    return {
      status: 400,
      code: "nothing_to_pay",
      error: "There is nothing to pay on this order.",
    }
  }
  return null
}
