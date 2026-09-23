import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getCart } from "../../../../services/orders/cart"
import { applyCartCredit, releaseCartCredit } from "../../../../services/wallet/cart-credit"
import { fail, quoted } from "../route"

/**
 * POST /store/cart/credit — put wallet credit on this cart, or take it off.
 *
 * ── What this replaces ─────────────────────────────────────────────────────────────────────────
 * Minting a Medusa gift card per redemption, attaching it, and disabling it again on removal. Three
 * writes and a live instrument the customer could see, all to express one number. It also never
 * worked: `GiftCardService.create` does not derive `balance` from `value` and the column is NOT
 * NULL, so every apply since the feature shipped failed on a not-null violation.
 *
 * Here credit is a redemption entry in the ledger, read back as a number on the cart. Nothing is
 * minted, so nothing has to be revoked.
 *
 * ── Why no amount is accepted ──────────────────────────────────────────────────────────────────
 * How much can be applied is the backend's answer, from the balance and the cart it reads itself.
 * A `requested` field would be a discount the page could choose — the redemption cap exists
 * precisely because that decision cannot live in the browser.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({ error: "Sign in to use your credit.", code: "AUTH_REQUIRED" })
    return
  }

  const body = (req.body ?? {}) as { cart_id?: string; action?: string }
  const action = body.action === "remove" ? "remove" : "apply"

  if (!body.cart_id) {
    res.status(400).json({ error: "cart_id is required.", code: "cart_id_required" })
    return
  }

  try {
    const cart = await getCart(body.cart_id)
    if (!cart) {
      res.status(404).json({ error: "Your cart has expired.", code: "no_cart" })
      return
    }
    if (cart.customerId && cart.customerId !== customerId) {
      res.status(403).json({ error: "That is not your cart.", code: "not_your_cart" })
      return
    }
    if (cart.status !== "active") {
      res.status(409).json({ error: "That cart has already been ordered.", code: "cart_closed" })
      return
    }

    if (action === "remove") {
      await releaseCartCredit({
        cartId: cart.id,
        reason: "Customer removed their credit at checkout",
      })
      res.status(200).json({ cart: await quoted(await getCart(cart.id)) })
      return
    }

    const result = await applyCartCredit({
      customerId,
      cartId: cart.id,
      brand: cart.brand,
      pincode: cart.pincode,
      /* What they would pay with no credit, and what credit is allowed to cover. The cap lives in
         the wallet service, which reads it from the versioned economics config — not from here. */
      payablePaise: cart.subtotalPaise + cart.deliveryPaise,
      redeemablePaise: cart.subtotalPaise,
    })

    const fresh = await getCart(cart.id)

    if (!("applied" in result) || !result.applied) {
      /* Nothing to apply is an ordinary answer, not a failure — somebody with an empty wallet
         pressing the button should see their unchanged total, not an error. */
      res.status(200).json({
        cart: await quoted(fresh),
        applied: false,
        reason: (result as any).reason ?? "nothing_to_apply",
      })
      return
    }

    res.status(200).json({ cart: await quoted(fresh), applied: true })
  } catch (error) {
    fail(res, error, `[store/cart/credit] ${body.cart_id}`)
  }
}
