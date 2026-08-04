import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { resolveShipping } from "../../../../services/checkout/shipping-resolver"
import { resolvePayment } from "../../../../services/checkout/payment-resolver"
import { buildCheckoutResponse } from "../../../../services/checkout/response-mapper"

/**
 * POST /store/checkout/initialize
 *
 * The single entry point into checkout — replaces what used to be 4 separate customer-visible
 * round trips (address, shipping method, create payment sessions, select payment session) with one.
 * The customer never chooses shipping or payment; CrossFriend's business rules do, via the
 * resolvers below. This route is the orchestrator: it calls the resolvers, drives the same
 * CartService methods Medusa's own routes call, and returns a response shaped for the frontend to
 * render directly — no Medusa cart internals leak through this contract.
 *
 * addShippingMethod is deliberately called OUTSIDE the shared transaction below — it opens its own
 * transaction at Medusa's requested SERIALIZABLE isolation internally, which gets silently
 * downgraded (never errors, just weakened) if nested inside a transaction opened at a lower
 * isolation level. Keeping it separate costs nothing (still one HTTP round trip) and preserves the
 * concurrency protection Medusa's own authors built in on purpose.
 *
 * Request body:
 *   {
 *     cartId: string
 *     shipping_address: object
 *     billing_address?: object   (defaults to shipping_address if omitted)
 *     email: string
 *   }
 *
 * Response 200: CheckoutResponse (see response-mapper.ts)
 * Response 400: missing/invalid input
 * Response 500: internal error
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const body = req.body as {
      cartId?: string
      shipping_address?: Record<string, unknown>
      billing_address?: Record<string, unknown>
      email?: string
    }

    if (!body.cartId) {
      return res.status(400).json({ error: "cartId is required" })
    }
    if (!body.shipping_address || !body.email) {
      return res.status(400).json({ error: "shipping_address and email are required" })
    }

    const cartId = body.cartId
    const cartService = req.scope.resolve("cartService")
    const manager = req.scope.resolve("manager")

    // 1. Address — its own transaction, no special isolation requirements to preserve.
    await manager.transaction(async (tm: any) => {
      await cartService.withTransaction(tm).update(cartId, {
        shipping_address: body.shipping_address,
        billing_address: body.billing_address ?? body.shipping_address,
        email: body.email,
      })
    })

    const cartForRegion = await cartService.retrieve(cartId, { select: ["id", "region_id"] })

    // 2. Shipping — resolved, not chosen by the client. Own transaction (see file comment).
    const shipping = await resolveShipping(req.scope, cartForRegion.region_id)
    await cartService.addShippingMethod(cartId, shipping.shippingOptionId)

    // 3. Payment — resolved, not chosen by the client. Shares one transaction; safe today since
    // "manual" never makes an external call. Revisit if a real gateway is added (see resolver).
    const payment = await resolvePayment()
    await manager.transaction(async (tm: any) => {
      const txCartService = cartService.withTransaction(tm)
      const cartWithSessions = await txCartService.retrieve(cartId, {
        relations: ["payment_sessions"],
      })
      if (!cartWithSessions.payment_sessions?.length) {
        await txCartService.setPaymentSessions(cartId)
      }
      await txCartService.setPaymentSession(cartId, payment.provider)
    })

    // 4. One final fetch — this is what the customer actually sees.
    const finalCart = await cartService.retrieveWithTotals(cartId, {
      relations: [
        "items",
        "items.variant",
        "shipping_address",
        "billing_address",
        "region",
        "shipping_methods",
        "shipping_methods.shipping_option",
        "payment_sessions",
        "customer",
      ],
    })

    return res.status(200).json(buildCheckoutResponse(finalCart, shipping, payment))
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[API /store/checkout/initialize] Error:", message)
    return res.status(500).json({ error: "Something went wrong preparing checkout. Please try again." })
  }
}
