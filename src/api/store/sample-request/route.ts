import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  createSampleRequest,
  SampleRequestError,
  sampleRequestsReady,
  type Brand,
} from "../../../services/support/sample-requests"

/**
 * POST /store/sample-request — ask for a free sample sachet.
 *
 * ── Why 503 when the table is missing ──────────────────────────────────────────────────────────
 * Migrations are applied separately and deliberately in this project, so there is a window where
 * this route exists and the table does not. Answering 503 lets the page say "the form is
 * temporarily unavailable, message us instead" — true, and actionable, because the WhatsApp link is
 * shown beside it. The one thing it must never do is report success without storing anything.
 *
 * ── Why the customer id comes from the token and never the body ────────────────────────────────
 * A signed-in requester is attached so OPS can see whether they have ordered before, which is
 * worth knowing when deciding what to put in the envelope. The id comes from the verified token,
 * so a request cannot claim to be somebody else. Being signed in is not required — the whole point
 * of a free sample is that it reaches people who have not bought anything.
 *
 * ── Why there is no confirmation email ─────────────────────────────────────────────────────────
 * Because this stack has no mail service: no SMTP credential, no transactional provider, no sending
 * domain. The email address is captured for when one exists and so OPS can reply by hand. Nothing
 * in the response or on the page promises a message that cannot be sent.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as {
    brand?: string
    name?: string
    phone?: string
    email?: string
    productHandle?: string
    addressLine1?: string
    addressLine2?: string
    landmark?: string
    city?: string
    state?: string
    pincode?: string
    reason?: string
    marketingOptIn?: boolean
  }

  const brand: Brand = body.brand === "crossfriend" ? "crossfriend" : "pranajiva"

  if (!(await sampleRequestsReady())) {
    res.status(503).json({
      error:
        "Our sample form is temporarily unavailable. Please message us on WhatsApp and we will arrange one for you.",
      code: "sample_requests_unavailable",
    })
    return
  }

  /* Behind a proxy the socket address is the proxy's. Trust the first hop of x-forwarded-for,
     which is what nginx sets, and fall back to the socket. Only ever hashed. */
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
  const sourceIp = forwarded.split(",")[0].trim() || req.socket?.remoteAddress || null

  try {
    const stored = await createSampleRequest({
      brand,
      name: body.name,
      phone: body.phone,
      email: body.email,
      productHandle: body.productHandle,
      addressLine1: body.addressLine1,
      addressLine2: body.addressLine2,
      landmark: body.landmark,
      city: body.city,
      state: body.state,
      pincode: body.pincode,
      reason: body.reason,
      marketingOptIn: body.marketingOptIn,
      customerId: req.user?.customer_id ?? null,
      sourceIp,
    })

    /* The id goes back so the requester has something to quote, and so OPS can find it without
       searching by name. */
    res.status(201).json({
      sampleRequest: { id: stored.id, created_at: stored.createdAt },
      message: "Thank you — your sample request is in. We post these in weekly batches.",
    })
  } catch (error) {
    if (error instanceof SampleRequestError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }
    console.error("[store/sample-request POST] could not store request:", error)
    res.status(500).json({
      error:
        "Something went wrong at our end and your request was not saved. Please message us on WhatsApp instead.",
      code: "unexpected",
    })
  }
}
