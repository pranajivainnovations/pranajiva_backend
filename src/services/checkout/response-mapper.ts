import type { Cart } from "@medusajs/medusa"
import type { ShippingResolution } from "./shipping-resolver"
import type { PaymentResolution } from "./payment-resolver"

export interface CheckoutResponse {
  checkoutReady: boolean
  cart: Cart
  totals: {
    subtotal: number
    shippingTotal: number
    taxTotal: number
    total: number
  }
  shipping: {
    method: string
    price: number
  }
  payment: {
    provider: string
    mode: "cod" | "online"
  }
  warnings: string[]
  nextAction: "PLACE_ORDER" | "COLLECT_PAYMENT"
}

/**
 * The one place the raw Medusa cart shape gets turned into what the frontend actually renders — the
 * frontend never needs to understand Medusa's cart/totals/shipping_methods structure directly.
 */
export function buildCheckoutResponse(
  cart: Cart,
  shipping: ShippingResolution,
  payment: PaymentResolution
): CheckoutResponse {
  return {
    checkoutReady: true,
    cart,
    totals: {
      subtotal: cart.subtotal ?? 0,
      shippingTotal: cart.shipping_total ?? 0,
      taxTotal: cart.tax_total ?? 0,
      total: cart.total ?? 0,
    },
    shipping: {
      method: shipping.shippingMethodName,
      price: shipping.shippingCost,
    },
    payment: {
      provider: payment.provider,
      mode: payment.paymentRequired ? "online" : "cod",
    },
    warnings: [],
    nextAction: payment.paymentRequired ? "COLLECT_PAYMENT" : "PLACE_ORDER",
  }
}
