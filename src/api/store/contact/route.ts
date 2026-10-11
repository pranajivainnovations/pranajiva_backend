import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  createEnquiry,
  EnquiryError,
  enquiriesReady,
  type Brand,
} from "../../../services/support/enquiries"

/**
 * POST /store/contact — file a contact-form enquiry.
 *
 * ── What this replaces ─────────────────────────────────────────────────────────────────────────
 * Nothing, which was the problem. The form posted to no endpoint at all: it waited 1500 ms behind
 * a `// Simulate API call` comment, said "Thank you! We'll get back to you soon", and threw the
 * message away. Every enquiry anyone has ever submitted through it is gone.
 *
 * ── Why it answers 503 when the table is missing ───────────────────────────────────────────────
 * The migration is applied separately and deliberately in this project, so there is a window where
 * this route exists and the table does not. Answering 503 lets the form say "our form is
 * temporarily unavailable, please call or email" — true, and actionable, because both are shown
 * beside it. The one thing it must never do again is report success without storing anything.
 *
 * ── Why the customer id is read from the token and never the body ──────────────────────────────
 * Signed-in senders are attached so OPS can see their order history; the id comes from the
 * verified token, so a request cannot claim to be somebody else. Being signed in is not required —
 * most people who need support are not.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as {
    brand?: string
    name?: string
    email?: string
    phone?: string
    subject?: string
    message?: string
  }

  const brand: Brand = body.brand === "pranajiva" ? "pranajiva" : "crossfriend"

  if (!(await enquiriesReady())) {
    res.status(503).json({
      error:
        "Our contact form is temporarily unavailable. Please call or email us and we will pick it up straight away.",
      code: "enquiries_unavailable",
    })
    return
  }

  /* Behind a proxy the socket address is the proxy's. Trust the first hop of x-forwarded-for,
     which is what nginx sets, and fall back to the socket. Only ever hashed. */
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
  const sourceIp = forwarded.split(",")[0].trim() || req.socket?.remoteAddress || null

  try {
    const stored = await createEnquiry({
      brand,
      name: body.name,
      email: body.email,
      phone: body.phone,
      subject: body.subject,
      message: body.message,
      customerId: req.user?.customer_id ?? null,
      sourceIp,
    })

    /* The id goes back so the sender has something to quote on the phone, and so support can find
       it without searching by name. */
    res.status(201).json({
      enquiry: { id: stored.id, created_at: stored.createdAt },
      message: "Thank you — we have your message and will reply soon.",
    })
  } catch (error) {
    if (error instanceof EnquiryError) {
      res.status(error.status).json({ error: error.message, code: error.code })
      return
    }
    console.error("[store/contact POST] could not store enquiry:", error)
    res.status(500).json({
      error:
        "Something went wrong at our end and your message was not saved. Please call or email us instead.",
      code: "unexpected",
    })
  }
}
