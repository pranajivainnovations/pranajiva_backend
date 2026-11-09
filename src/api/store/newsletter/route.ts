import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  newsletterReady,
  NewsletterError,
  subscribeToNewsletter,
  type Brand,
} from "../../../services/support/newsletter"

/**
 * POST /store/newsletter — leave an email address to hear about new products.
 *
 * ── Why 503 when the table is missing ──────────────────────────────────────────────────────────
 * Migrations are applied separately and deliberately in this project, so there is a window where
 * this route exists and the table does not. Answering 503 lets the footer say the address could
 * not be saved, which is true. The one thing it must never do is report success without storing
 * anything — that is exactly the fault this route was written to remove.
 *
 * ── Why the answer is the same for a new address and a repeat ──────────────────────────────────
 * Saying "already on the list" would tell whoever typed the address that its owner signed up here.
 * Both cases get the same sentence and the same status.
 *
 * ── Why the message promises nothing by email ──────────────────────────────────────────────────
 * This stack has no mail service. No confirmation is sent, so none is mentioned.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as {
    brand?: string
    email?: string
    source?: string
  }

  const brand: Brand = body.brand === "crossfriend" ? "crossfriend" : "pranajiva"

  if (!(await newsletterReady())) {
    res.status(503).json({
      error: "We cannot save email addresses just now. Please try again in a few days.",
      code: "newsletter_unavailable",
    })
    return
  }

  /* Behind a proxy the socket address is the proxy one. Trust the first hop of x-forwarded-for,
     which is what nginx sets, and fall back to the socket. Only ever hashed. */
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
  const sourceIp = forwarded.split(",")[0].trim() || req.socket?.remoteAddress || null

  try {
    await subscribeToNewsletter({
      brand,
      email: body.email,
      source: body.source,
      customerId: req.user?.customer_id ?? null,
      sourceIp,
    })

    res.status(201).json({
      message: "You are on the list. We will write when there is something new.",
    })
  } catch (error) {
    if (error instanceof NewsletterError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }
    console.error("[store/newsletter POST] could not store sign-up:", error)
    res.status(500).json({
      error: "Something went wrong at our end and your email was not saved. Please try again later.",
      code: "unexpected",
    })
  }
}
