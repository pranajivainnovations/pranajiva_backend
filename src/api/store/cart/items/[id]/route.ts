import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { removeItem, setItemQty } from "../../../../../services/orders/cart"
import { fail, quoted } from "../../route"

/**
 * One line in the cart.
 *
 * POST changes the quantity; DELETE removes it. Both answer with the whole cart, so the page that
 * asked does not need a second call to redraw its totals.
 *
 * The cart id travels in the body rather than being inferred from the item, on purpose: an item id
 * alone would let anybody who guessed one edit a stranger's cart. Both must agree, and the service
 * scopes every write to the pair.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const itemId = req.params.id
  const body = (req.body ?? {}) as { cart_id?: string; qty?: number }

  if (!body.cart_id) {
    res.status(400).json({ error: "cart_id is required.", code: "cart_id_required" })
    return
  }
  if (typeof body.qty !== "number") {
    res.status(400).json({ error: "qty is required.", code: "qty_required" })
    return
  }

  try {
    /* Zero means remove, which is what a quantity stepper does at its lower bound — handled here
       rather than making the page know to call a different endpoint. */
    const cart = await setItemQty({ cartId: body.cart_id, itemId, qty: body.qty })
    res.status(200).json({ cart: await quoted(cart) })
  } catch (error) {
    fail(res, error, `[store/cart/items POST] ${itemId}`)
  }
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const itemId = req.params.id
  const cartId =
    (typeof req.query.cart_id === "string" ? req.query.cart_id : null) ??
    ((req.body ?? {}) as { cart_id?: string }).cart_id

  if (!cartId) {
    res.status(400).json({ error: "cart_id is required.", code: "cart_id_required" })
    return
  }

  try {
    const cart = await removeItem({ cartId, itemId })
    res.status(200).json({ cart: await quoted(cart) })
  } catch (error) {
    fail(res, error, `[store/cart/items DELETE] ${itemId}`)
  }
}
