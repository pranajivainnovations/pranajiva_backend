import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { addItem, type ItemKind } from "../../../../services/orders/cart"
import { fail } from "../route"

/**
 * POST /store/cart/items — put something in the cart.
 *
 * ── The line that deletes a whole route ────────────────────────────────────────────────────────
 * A studio design is added by its own id:
 *
 *     { kind: "studio_design", ref_id: "<design id>", spec: { weight, flavor, selections } }
 *
 * Before this, adding a cake to a cart meant first creating a draft Medusa product with a variant,
 * a shipping profile, a sales channel and an inventory quantity of zero — because `addItem` took a
 * variantId and a cake had to become a catalogue entry to be bought. /store/ai-studio/product exists
 * for exactly that reason and stops being needed here.
 *
 * ── One call, not four ─────────────────────────────────────────────────────────────────────────
 * The response is the whole cart with totals and credit, so the page that follows an add — the cart
 * page, or checkout — renders without asking again. Each round trip saved is real latency on the
 * customer's phone.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as {
    cart_id?: string
    kind?: string
    ref_id?: string
    qty?: number
    spec?: Record<string, unknown>
  }

  if (!body.cart_id) {
    res.status(400).json({ error: "cart_id is required.", code: "cart_id_required" })
    return
  }
  if (body.kind !== "catalogue" && body.kind !== "studio_design") {
    res.status(400).json({
      error: "kind must be catalogue or studio_design.",
      code: "bad_kind",
    })
    return
  }
  if (!body.ref_id) {
    res.status(400).json({ error: "ref_id is required.", code: "ref_id_required" })
    return
  }

  try {
    const cart = await addItem({
      cartId: body.cart_id,
      kind: body.kind as ItemKind,
      refId: body.ref_id,
      qty: body.qty,
      /* Whatever the customer configured. Priced by the server from these, never by the caller —
         there is no amount field in this request to honour. */
      spec: body.spec ?? {},
    })
    res.status(200).json({ cart })
  } catch (error) {
    fail(res, error, `[store/cart/items POST] ${body.cart_id}`)
  }
}
