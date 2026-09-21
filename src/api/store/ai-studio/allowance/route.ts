import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getAllowance } from "../../../../services/ai-studio/allowance"

/**
 * GET /store/ai-studio/allowance — how many designs this customer has left.
 *
 * ── Why the Studio page needs this before it generates anything ────────────────────────────────
 * The badge used to read its number out of a JSON config file shipped with the storefront, which
 * said 50 because somebody set it to 50 for testing. It was never the real allowance and it could
 * not be: the real one is the configured base plus whatever support has given this particular
 * person, minus what they have already used.
 *
 * So the page asks. What it is told here is the same figure the generate route will enforce, which
 * means a customer is never shown attempts that do not exist — the failure this replaces, where
 * somebody watched a badge count down from 50 and was refused at 10.
 *
 * ── Whose allowance ────────────────────────────────────────────────────────────────────────────
 * The customer id comes from the verified token and from nowhere else. There is no parameter naming
 * a customer, so "read somebody else's standing" is not a request this route can be made to serve.
 *
 * GET is the only export. Medusa's file router registers exactly the methods a route file exports,
 * so this endpoint cannot grant anything — topping somebody up is an ops act, attributed to a named
 * person, and lives behind the service key on /ops/ai-studio/generations.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({
      error: "Sign in to see how many designs you have left.",
      code: "AUTH_REQUIRED",
    })
    return
  }

  try {
    const allowance = await getAllowance(customerId)

    res.status(200).json({
      remaining: allowance.remaining,
      total: allowance.total,
      used: allowance.used,
      allowed: allowance.allowed,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[store/ai-studio/allowance]", message)
    /* Not fatal to the page. The Studio still works — the badge simply does not render — and
       generation is refused by the generate route itself if they really are out, so a failure here
       cannot hand anybody a free attempt. */
    res.status(500).json({ error: "Could not read your remaining designs." })
  }
}
