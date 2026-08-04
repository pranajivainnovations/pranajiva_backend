export interface PaymentResolution {
  provider: string
  paymentRequired: boolean
}

/**
 * Decides how this order gets paid for — the checkout route doesn't know or care why. Today it's
 * always COD via the "manual" provider. Tomorrow: COD if the pincode supports it, else Razorpay —
 * this is the one place that decision lives; the route and response contract don't change,
 * `paymentRequired` just flips to true and the frontend gets a `paymentProvider` to act on.
 */
export async function resolvePayment(): Promise<PaymentResolution> {
  return { provider: "manual", paymentRequired: false }
}
