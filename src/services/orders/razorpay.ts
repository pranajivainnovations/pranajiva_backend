import crypto from "crypto"

/**
 * Razorpay, spoken directly.
 *
 * ── Why not the plugin ─────────────────────────────────────────────────────────────────────────
 * medusa-payment-razorpay fails quietly in two places that cost us a week. `initiatePayment` builds
 * a Razorpay *customer* before the order and, when that fails, logs a line and returns a session
 * with no order in it — nothing throws, and the storefront is left inventing an explanation.
 * `updatePayment` returns early when the cart has no billing address, so the order is never rebuilt
 * when the total changes and a customer can be shown a stale amount.
 *
 * Underneath all of it are three HTTP calls and one HMAC. That is this file.
 *
 * ── The rule about who decides ─────────────────────────────────────────────────────────────────
 * Razorpay is the only authority on whether money moved, and it never writes into our database. It
 * answers when asked, or tells us when it happens. Everything here is built on that: the browser's
 * callback and the webhook are both *notifications*, and neither is trusted without asking Razorpay
 * directly. See verifyPaid below — the signature is a filter, the fetch is the answer.
 */

const API = "https://api.razorpay.com/v1"

export interface RazorpayOrder {
  id: string
  amount: number
  currency: string
  status: string
  receipt?: string
}

export class RazorpayError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = "RazorpayError"
  }
}

function credentials(): { keyId: string; keySecret: string } {
  const keyId = String(process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_ID || "")
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET || "")

  /* `rzp_` rather than merely non-empty: the placeholder `your_razorpay_key_id` sat in .env for
     months and is perfectly truthy. A shape check is what turns that into a clear refusal instead
     of a 401 from Razorpay at the moment a customer presses pay. */
  if (!keyId.startsWith("rzp_") || !keySecret) {
    throw new RazorpayError(
      "gateway_unconfigured",
      "Card payment is unavailable right now. Please contact us to complete your order."
    )
  }
  return { keyId, keySecret }
}

export function isConfigured(): boolean {
  try {
    credentials()
    return true
  } catch {
    return false
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const { keyId, keySecret } = credentials()
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64")

  /* Razorpay is on the customer's critical path — a hung socket must not hold a checkout open. */
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 15_000)

  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      signal: abort.signal,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    })

    const body = (await res.json().catch(() => ({}))) as any

    if (!res.ok) {
      const detail = body?.error?.description || `Razorpay answered ${res.status}`
      throw new RazorpayError("gateway_error", detail)
    }
    return body as T
  } catch (error) {
    if (error instanceof RazorpayError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new RazorpayError("gateway_unreachable", `Could not reach Razorpay: ${message}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create the order Razorpay will collect against.
 *
 * `receipt` carries our own order id, so a payment found in the Razorpay dashboard can be traced
 * back without a lookup table. Deliberately no customer creation: that is the call the plugin made
 * first and failed on, and Razorpay does not need it to take a payment.
 */
export async function createRazorpayOrder(input: {
  amountPaise: number
  receipt: string
  notes?: Record<string, string>
}): Promise<RazorpayOrder> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new RazorpayError("bad_amount", "There is nothing to pay on this order.")
  }

  return call<RazorpayOrder>("/orders", {
    method: "POST",
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.receipt.slice(0, 40),
      notes: input.notes ?? {},
      payment_capture: 1,
    }),
  })
}

export async function fetchRazorpayOrder(orderId: string): Promise<RazorpayOrder> {
  return call<RazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`)
}

/**
 * Did Razorpay produce this callback?
 *
 * HMAC over `order_id|payment_id` with the key secret. Only Razorpay and we know that secret, so a
 * valid signature proves the values came from them — a forged callback from an edited page cannot
 * produce one. Constant-time comparison, because a timing oracle on a signature check is a way to
 * forge one given enough attempts.
 */
export function verifySignature(input: {
  razorpayOrderId: string
  razorpayPaymentId: string
  signature: string
}): boolean {
  try {
    const { keySecret } = credentials()
    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
      .digest("hex")
    return timingSafeEqual(expected, input.signature)
  } catch {
    return false
  }
}

/** Webhook bodies are signed with a different secret, over the raw bytes as sent. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret || !signature) return false
  try {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
    return timingSafeEqual(expected, signature)
  } catch {
    return false
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * The only question that matters: has Razorpay been paid for this order?
 *
 * ── Why this always asks Razorpay, even when a signature checked out ───────────────────────────
 * Because the signature proves who sent the message, not what happened. A valid signature on a
 * `payment.failed` event is still a valid signature. And a webhook secret that is unset — as it was
 * here until recently — makes signature verification return false for every genuine delivery, which
 * would silently stop confirming real orders.
 *
 * So the fetch is the authority and the signature is a cheap filter in front of it. The practical
 * effect is that a forged callback costs us one API call and achieves nothing, and a missing
 * webhook secret degrades to "slower" rather than "broken".
 */
export async function verifyPaid(razorpayOrderId: string): Promise<{
  paid: boolean
  amountPaise: number
  status: string
}> {
  const order = await fetchRazorpayOrder(razorpayOrderId)
  return {
    paid: order.status === "paid",
    amountPaise: Number(order.amount ?? 0),
    status: String(order.status ?? "unknown"),
  }
}
