import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { claimCart } from "../../../../services/orders/cart"
import { OrderError, placeOrder } from "../../../../services/orders/order"
import { isConfigured } from "../../../../services/orders/razorpay"

/**
 * POST /store/checkout/place — one call from "press pay" to "here is how to pay".
 *
 * ── What it replaces ───────────────────────────────────────────────────────────────────────────
 * Four round trips: set the address, add a shipping method, create payment sessions, select one.
 * Each cost a browser-to-backend hop, and the last two made two to four calls to Razorpay's API
 * between them because the plugin creates or polls for a customer before it creates an order.
 *
 * ── Where the OTP requirement lands ────────────────────────────────────────────────────────────
 * Here, and nowhere earlier. A visitor fills a cart signed out; this is the first thing that needs
 * to know who they are. If they signed in during the Studio — which generation already requires —
 * the same session carries through and there is nothing extra to do.
 *
 * `claimCart` runs before the order because a guest cart has to become theirs first, and because
 * they may already have a cart from another device. That merge belongs before an order is written,
 * not after.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({
      error: "Please verify your mobile number to place this order.",
      code: "AUTH_REQUIRED",
    })
    return
  }

  const body = (req.body ?? {}) as {
    cart_id?: string
    address?: Record<string, unknown>
  }

  if (!body.cart_id) {
    res.status(400).json({ error: "cart_id is required.", code: "cart_id_required" })
    return
  }

  const address = body.address ?? {}
  const missing = ["first_name", "address_1", "city", "postal_code", "phone"].filter(
    (k) => !String((address as any)[k] ?? "").trim()
  )
  if (missing.length) {
    /* Named, because "some required fields are missing" on a page whose fields all look filled in
       is the dead end this storefront already shipped once. */
    res.status(400).json({
      error: `Please add your ${missing.map(label).join(", ")}.`,
      code: "address_incomplete",
      missing,
    })
    return
  }

  if (!isConfigured()) {
    res.status(503).json({
      error: "Card payment is unavailable right now. Please contact us to complete your order.",
      code: "gateway_unconfigured",
    })
    return
  }

  try {
    /* Guest cart becomes theirs — and merges with any cart they already had. Returns the surviving
       cart, whose id may differ from the one the browser sent. */
    const cart = await claimCart({ cartId: body.cart_id, customerId })

    const { order } = await placeOrder({ cartId: cart.id, customerId, address })

    res.status(200).json({
      order: {
        id: order.id,
        display_id: order.displayId,
        payable_paise: order.payablePaise,
        credit_applied_paise: order.creditAppliedPaise,
        payment_status: order.paymentStatus,
      },
      /* Everything the payment window needs, already settled. The browser passes it through and
         decides nothing — see the shared razorpay module in the storefronts. */
      payment: {
        key_id: process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_ID,
        order_id: order.razorpayOrderId,
        amount: order.payablePaise,
        currency: "INR",
        name: cart.brand === "pranajiva" ? "PranaJiva" : "CrossFriend",
        prefill: {
          name: [address.first_name, address.last_name].filter(Boolean).join(" ") || undefined,
          contact: String(address.phone ?? "") || undefined,
          email: String((address as any).email ?? "") || undefined,
        },
        notes: { order_id: order.id },
      },
      /* The cart the browser should now hold, which the merge may have changed. */
      cart_id: cart.id,
    })
  } catch (error) {
    if (error instanceof OrderError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[store/checkout/place] ${customerId}: ${message}`)
    res.status(500).json({
      error: "Something went wrong placing your order. Please try again.",
      code: "unexpected",
    })
  }
}

function label(key: string): string {
  return (
    {
      first_name: "name",
      address_1: "address",
      city: "city",
      postal_code: "pincode",
      phone: "phone number",
    } as Record<string, string>
  )[key] ?? key
}
