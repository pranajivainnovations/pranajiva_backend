import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  getOpenRequest,
  submitRefineRequest,
} from "../../../../services/ai-studio/refine-requests"

/**
 * "We'll refine it for you" — where the customer's ask arrives.
 *
 * ── Why this endpoint exists at all ────────────────────────────────────────────────────────────
 * The Studio has two dead ends. One is a customer who has generated ten designs and still not seen
 * the cake in their head; the other is a customer whose allowance has run out and who is told, by
 * the generate route, to talk to us. Before this, "talk to us" meant nothing in particular — there
 * was nowhere for the talking to land.
 *
 * Both dead ends are the same person: somebody trying to buy a cake. This turns the end of the road
 * into the start of a conversation, and puts that conversation in a queue somebody is looking at.
 *
 * ── Whose request ──────────────────────────────────────────────────────────────────────────────
 * The customer id comes from the verified token and nowhere else, so nobody can file a request
 * against somebody else's account or read one. Signing in is already required to generate, so this
 * asks nothing extra of anybody who got far enough to need it.
 *
 * ── What it deliberately does not do ───────────────────────────────────────────────────────────
 * Grant anything. It would be easy to hand out a few generations automatically when somebody asks
 * for help, and it would undo the point: the allowance exists so that the expensive case reaches a
 * person. Topping somebody up stays an ops act with a name and a reason on it.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({
      error: "Sign in so we can get back to you.",
      code: "AUTH_REQUIRED",
    })
    return
  }

  const body = (req.body ?? {}) as {
    message?: string
    contact?: string
    generationId?: string
    designId?: string
  }

  const message = String(body.message ?? "").trim()

  if (message.length < 3) {
    res.status(400).json({
      error: "Tell us what you are looking for and we will take it from there.",
      code: "MESSAGE_REQUIRED",
    })
    return
  }

  try {
    const request = await submitRefineRequest({
      customerId,
      message,
      contact: body.contact,
      generationId: body.generationId,
      designId: body.designId,
    })

    res.status(200).json({
      received: true,
      requestId: request.id,
      /**
       * Said differently when we already had one open, because the customer is usually pressing
       * again out of doubt that the first one worked. Confirming we have it is the answer to that
       * doubt; "you have already asked" is a reprimand for a reasonable act.
       */
      message: request.alreadyOpen
        ? "We already have your request and someone will be in touch. We have updated it with what you just told us."
        : "Got it. Someone will look at this and get back to you.",
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[store/ai-studio/refine] ${customerId}: ${detail}`)
    res.status(500).json({
      error: "We could not send that just now. Please try again in a moment.",
      code: "UNEXPECTED",
    })
  }
}

/**
 * GET /store/ai-studio/refine — do we already have one open from this customer?
 *
 * So the page can show "we have your request" instead of an empty form somebody fills in twice.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({ open: null, code: "AUTH_REQUIRED" })
    return
  }

  try {
    const open = await getOpenRequest(customerId)
    res.status(200).json({ open })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[store/ai-studio/refine GET] ${customerId}: ${detail}`)
    /* Not fatal. The panel renders as if nothing is open, and a duplicate submission is folded into
       the existing request by the database anyway. */
    res.status(200).json({ open: null })
  }
}
