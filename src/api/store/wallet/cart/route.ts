import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  applyCartCredit,
  getCartCredit,
  isNotApplied,
  quoteCartCredit,
  releaseCartCredit,
} from "../../../../services/wallet/cart-credit"
import type { Brand } from "../../../../services/wallet/ledger"

/**
 * Spending wallet credit on a cart — the Medusa half.
 *
 * ── Why a gift card ────────────────────────────────────────────────────────────────────────────
 * Medusa has to know the order is smaller, or the order record says ₹699 while the customer paid
 * ₹599 and every report afterwards is wrong. It offers exactly two ways to reduce a total, and a
 * discount is not usable here: a discount is a marketing object with its own eligibility rules, and
 * products can opt out of them entirely. A gift card applies to the total regardless, and Medusa's
 * own arithmetic then carries it through the payment amount and into the order record.
 *
 * ── What "redeemable" means, and why it is Medusa's number ─────────────────────────────────────
 * Items after any campaign — not delivery, not tax. That is the platform's rule, read off the cart it
 * has already totalled rather than reimplemented: a second opinion here would eventually disagree,
 * and the symptom would be a customer offered credit that checkout then refuses to take in full.
 *
 * ── The order of operations, and why it is this order ──────────────────────────────────────────
 * Debit, then mint, then attach. The debit is the step that can legitimately fail — the balance may
 * have moved — and it fails before the customer has been shown a smaller number. If minting or
 * attaching then fails, the debit is reversed immediately, so the failure mode is "nothing happened"
 * rather than "your credit is gone and your cart costs the same".
 */

/** Marks a gift card as one the wallet created, so nothing else is ever mistaken for one. */
const WALLET_GIFT_CARD = "wallet_credit"

function brandOf(channelName: string | null | undefined): Brand {
  return String(channelName ?? "").toLowerCase() === "pranajiva" ? "pranajiva" : "crossfriend"
}

/**
 * What a gift card may cover on this cart: goods after discount.
 *
 * Taken from the cart Medusa has already totalled, so the figure is the one its own gift card logic
 * will use when it applies the card.
 */
function redeemableOf(cart: any): number {
  const subtotal = Number(cart.subtotal ?? 0)
  const discount = Number(cart.discount_total ?? 0)
  return Math.max(0, subtotal - discount)
}

/**
 * What the customer would pay with no credit applied — the figure at the bottom of their screen.
 *
 * ── Why the gift card already on the cart is added back ────────────────────────────────────────
 * Once credit is applied, Medusa's total is net of it, and quoting the cap against that number would
 * measure the cap against a figure the credit itself had already reduced. Adding it back asks the
 * question that was actually meant: what would this order cost if they paid for all of it.
 */
function payableOf(cart: any): number {
  const total = Number(cart.total ?? 0)
  const giftCards = Number(cart.gift_card_total ?? 0)
  return Math.max(0, total + giftCards)
}

/** The wallet's own gift card on this cart, if it has one. */
function walletCardOn(cart: any): any | null {
  return (cart.gift_cards ?? []).find((g: any) => g?.metadata?.source === WALLET_GIFT_CARD) ?? null
}

const CART_RELATIONS = ["items", "region", "gift_cards", "shipping_address", "sales_channel"]

/**
 * GET /store/wallet/cart?cart_id=… — what could be applied, and what already is.
 *
 * Read-only and safe to call on every checkout render.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id
  const cartId = String(req.query.cart_id ?? "")

  if (!customerId) {
    res.status(401).json({ error: "Sign in to use your credit.", code: "AUTH_REQUIRED" })
    return
  }
  if (!cartId) {
    res.status(400).json({ error: "cart_id is required." })
    return
  }

  try {
    const cartService = req.scope.resolve("cartService") as any
    const cart = await cartService.retrieveWithTotals(cartId, { relations: CART_RELATIONS })

    if (cart.customer_id && cart.customer_id !== customerId) {
      res.status(403).json({ error: "That is not your cart." })
      return
    }

    const quote = await quoteCartCredit({
      customerId,
      cartId,
      brand: brandOf(cart.sales_channel?.name),
      pincode: cart.shipping_address?.postal_code ?? null,
      payablePaise: payableOf(cart),
      redeemablePaise: redeemableOf(cart),
    })

    res.status(200).json(quote)
  } catch (error) {
    console.error("[store/wallet/cart] read failed", error)
    res.status(500).json({ error: "Could not check your credit right now." })
  }
}

/**
 * POST /store/wallet/cart — apply or remove.
 *
 * One route with an action rather than two, because both share every piece of resolution — the cart,
 * its owner, its brand, its gift card — and splitting them would mean keeping two copies of that
 * correct.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id
  const body = (req.body ?? {}) as { cartId?: string; action?: string }
  const cartId = String(body.cartId ?? "")
  const action = body.action === "remove" ? "remove" : "apply"

  if (!customerId) {
    res.status(401).json({ error: "Sign in to use your credit.", code: "AUTH_REQUIRED" })
    return
  }
  if (!cartId) {
    res.status(400).json({ error: "cartId is required." })
    return
  }

  const cartService = req.scope.resolve("cartService") as any
  const giftCardService = req.scope.resolve("giftCardService") as any

  try {
    const cart = await cartService.retrieveWithTotals(cartId, { relations: CART_RELATIONS })

    if (cart.customer_id && cart.customer_id !== customerId) {
      res.status(403).json({ error: "That is not your cart." })
      return
    }

    if (action === "remove") {
      const card = walletCardOn(cart)

      if (card) {
        /**
         * Detached, then disabled.
         *
         * The card's code is visible to whoever can read the cart, which is the customer. A card that
         * is only detached is a live instrument they have already seen — and could apply to a second
         * order after getting their credit back here. Disabling it is what makes the two halves of
         * this operation add up.
         */
        await cartService.update(cartId, {
          gift_cards: (cart.gift_cards ?? [])
            .filter((g: any) => g.id !== card.id)
            .map((g: any) => ({ code: g.code })),
        })
        await giftCardService.update(card.id, { is_disabled: true })
      }

      const released = await releaseCartCredit({
        cartId,
        reason: "Customer removed their credit at checkout",
      })

      res.status(200).json({ removed: true, releasedPaise: released.releasedPaise })
      return
    }

    /* Applying twice is the ordinary consequence of a slow response and a second click. */
    if (walletCardOn(cart)) {
      const existing = await getCartCredit(cartId)
      res.status(200).json({
        applied: true,
        alreadyApplied: true,
        amountPaise: existing?.amountPaise ?? 0,
      })
      return
    }

    const result = await applyCartCredit({
      customerId,
      cartId,
      brand: brandOf(cart.sales_channel?.name),
      pincode: cart.shipping_address?.postal_code ?? null,
      payablePaise: payableOf(cart),
      redeemablePaise: redeemableOf(cart),
    })

    if (isNotApplied(result)) {
      res.status(200).json({
        applied: false,
        reason: result.reason,
        amountPaise: result.amountPaise,
        message:
          result.reason === "already_applied"
            ? "Your credit is already on this order."
            : "There is no credit to apply to this order.",
      })
      return
    }

    /**
     * From here the wallet has already moved, so every failure path puts it back.
     *
     * A customer whose credit vanished while their cart stayed the same price would have no way to
     * tell what happened and no way to undo it, and support would be hunting for a debit with no
     * discount anywhere near it.
     */
    try {
      const card = await giftCardService.create({
        value: result.amountPaise,
        region_id: cart.region_id,
        is_disabled: false,
        metadata: { source: WALLET_GIFT_CARD, cart_id: cartId, customer_id: customerId },
      })

      await cartService.update(cartId, {
        gift_cards: [
          ...(cart.gift_cards ?? []).map((g: any) => ({ code: g.code })),
          { code: card.code },
        ],
      })
    } catch (error) {
      await releaseCartCredit({
        cartId,
        reason: "Could not attach the credit to the cart — returned automatically",
      }).catch(() => {})
      throw error
    }

    const after = await cartService.retrieveWithTotals(cartId, { relations: CART_RELATIONS })

    res.status(200).json({
      applied: true,
      amountPaise: result.amountPaise,
      cartTotal: Number(after.total ?? 0),
      giftCardTotal: Number(after.gift_card_total ?? 0),
    })
  } catch (error) {
    console.error("[store/wallet/cart] write failed", error)
    res.status(500).json({ error: "Could not update your credit on this order." })
  }
}
