import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { quoteRedemption } from "../../../../services/wallet/redemption"
import type { Brand } from "../../../../services/wallet/ledger"

/**
 * GET /store/wallet/quote — how much credit this customer could put towards an order.
 *
 * ── Read-only, and that is the point ───────────────────────────────────────────────────────────
 * It answers a question and writes nothing. Credit is actually spent when an order is placed, by
 * the server, against a real order id — never by a browser asking for it. A customer-callable
 * endpoint that moved money would let anybody drain their own balance without ever buying
 * anything, which is not fraud so much as a bug that costs money.
 *
 * ── Whose wallet ───────────────────────────────────────────────────────────────────────────────
 * The token's. There is no customer parameter, so this cannot be asked about somebody else.
 *
 * The order total comes from the caller because the cart lives on the storefront's side of this
 * request. That is safe: a customer inflating it only asks for a larger cap, and the cap is applied
 * again — against the real order — at the moment credit is actually spent. Nothing here is binding.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({ error: "Sign in to use your credit.", code: "AUTH_REQUIRED" })
    return
  }

  const q = req.query as Record<string, unknown>
  const brand = (q.brand === "pranajiva" ? "pranajiva" : "crossfriend") as Brand
  const pincode = q.pincode && /^[1-9][0-9]{5}$/.test(String(q.pincode))
    ? String(q.pincode)
    : null

  const orderTotalPaise = Number(q.totalPaise)
  if (!Number.isFinite(orderTotalPaise) || orderTotalPaise <= 0) {
    res.status(400).json({ error: "A positive order total is required." })
    return
  }

  const requested = q.requestedPaise === undefined ? undefined : Number(q.requestedPaise)
  if (requested !== undefined && (!Number.isFinite(requested) || requested < 0)) {
    res.status(400).json({ error: "The requested amount must be a positive number." })
    return
  }

  try {
    const quote = await quoteRedemption({
      customerId,
      brand,
      pincode,
      orderTotalPaise: Math.floor(orderTotalPaise),
      requestedPaise: requested === undefined ? undefined : Math.floor(requested),
    })

    res.status(200).json({
      ...quote,
      /* Said in the response rather than left to each storefront to phrase, so the reason a
         customer cannot spend all of their balance reads the same everywhere. */
      message:
        quote.applicablePaise === 0
          ? quote.balancePaise === 0
            ? "You have no credit to use yet."
            : "Your credit cannot be used on this order."
          : quote.limitedBy === "cap"
            ? `Up to ${(quote.capBps / 100).toFixed(0)}% of an order can be paid with credit.`
            : null,
    })
  } catch (error) {
    console.error("[store/wallet/quote] failed", error)
    res.status(500).json({ error: "Could not work out your credit right now." })
  }
}
