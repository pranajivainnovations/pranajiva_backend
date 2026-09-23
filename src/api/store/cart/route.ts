import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  attachCreditQuote,
  getCart,
  getOrCreateCart,
  type Brand,
  type Cart,
} from "../../../services/orders/cart"

/**
 * The cart, ours.
 *
 * ── Why these routes take no price ─────────────────────────────────────────────────────────────
 * Nothing a browser sends here can influence what anything costs. A caller says which cart, and the
 * service resolves everything else. That is deliberate and structural rather than validated: there
 * is no price field to reject.
 *
 * ── Why signing in is optional ─────────────────────────────────────────────────────────────────
 * A visitor fills a cart before they have told us who they are, and is asked to verify a mobile
 * number only when they place the order. `req.user` is read when present and simply absent when it
 * is not — no branch here refuses a guest.
 */

/**
 * Every cart that leaves these routes carries what the wallet would allow on it.
 *
 * Attached here rather than inside the service because the quote reads a different pool and the
 * service's writes hold an advisory lock on the cart — see attachCreditQuote. Null-safe: a cart
 * that was not found stays not found rather than turning into a quote failure.
 */
export async function quoted(cart: Cart | null): Promise<Cart | null> {
  return cart ? attachCreditQuote(cart) : null
}

function brandOf(req: MedusaRequest): Brand {
  return req.query.brand === "pranajiva" || (req.body as any)?.brand === "pranajiva"
    ? "pranajiva"
    : "crossfriend"
}

/**
 * GET /store/cart?cart_id=…
 *
 * Returns the cart with its totals and whatever credit is already on it — everything the cart page
 * and the checkout page need, in one response. The checkout page normally renders from the response
 * to an add, so this is for somebody arriving cold.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id ?? null
  const cartId = typeof req.query.cart_id === "string" ? req.query.cart_id : null

  try {
    if (!cartId && !customerId) {
      /* Nothing to find and nobody to find it for. Not an error — an empty cart is a legitimate
         state and the page should render, not fail. */
      res.status(200).json({ cart: null })
      return
    }

    if (cartId && !customerId) {
      res.status(200).json({ cart: await quoted(await getCart(cartId)) })
      return
    }

    const cart = await getOrCreateCart({
      customerId,
      cartId,
      brand: brandOf(req),
      pincode: typeof req.query.pincode === "string" ? req.query.pincode : null,
    })
    res.status(200).json({ cart: await quoted(cart) })
  } catch (error) {
    fail(res, error, `[store/cart GET] ${cartId}`)
  }
}

/**
 * POST /store/cart — the cart this browser should be using.
 *
 * Idempotent by design: a signed-in customer gets their one active cart for the brand, a guest gets
 * the one their cookie names, and only a visitor with neither gets a new row. Calling it twice does
 * not produce two carts.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as { cart_id?: string; pincode?: string }

  try {
    const cart = await getOrCreateCart({
      customerId: req.user?.customer_id ?? null,
      cartId: body.cart_id ?? null,
      brand: brandOf(req),
      pincode: body.pincode ?? null,
    })
    res.status(200).json({ cart: await quoted(cart) })
  } catch (error) {
    fail(res, error, "[store/cart POST]")
  }
}

export function fail(res: MedusaResponse, error: unknown, where: string): void {
  const code = (error as any)?.code
  if (code && (error as any)?.name === "CartError") {
    res.status(code === "not_your_cart" ? 403 : 400).json({
      error: (error as Error).message,
      code,
    })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${where}: ${message}`)
  res.status(500).json({ error: "Something went wrong with your cart.", code: "unexpected" })
}
