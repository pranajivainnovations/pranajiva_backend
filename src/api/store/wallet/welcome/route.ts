import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import type { Brand } from "../../../../services/wallet/ledger"
import { issueSignupBonus } from "../../../../services/wallet/signup-bonus"

/**
 * POST /store/wallet/welcome — claim the welcome bonus, now that we know where you are.
 *
 * ── Why this is not settled at sign-in alone ───────────────────────────────────────────────────
 * A visitor who skipped the pincode prompt signs in with no area, and an offer that runs in named
 * pincodes cannot be handed to somebody who might be anywhere. That is a reason to wait, not a reason
 * to refuse for ever: the moment they tell us where they are — on their next visit, at checkout, a
 * month later — the question can be answered, and if a bonus runs there they should have it.
 *
 * So the rule is "no pincode, no bonus yet" rather than "no bonus". This is the route that settles it
 * the moment the pincode arrives.
 *
 * ── Why calling it repeatedly is safe ──────────────────────────────────────────────────────────
 * The storefront calls this every time a signed-in customer sets a pincode, which for a regular
 * customer is several times a year. A unique index on (customer_id, brand) means the second and
 * fortieth calls write nothing, so there is no counter to keep and nothing to remember.
 *
 * ── Why a refusal is a 200 ─────────────────────────────────────────────────────────────────────
 * Almost every outcome is ordinary — they already have one, no campaign is running, their area is not
 * in it. None of those is an error on the caller's part, and returning 4xx would fill the logs with
 * red for a feature working exactly as designed.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({ error: "Sign in first.", code: "AUTH_REQUIRED" })
    return
  }

  const body = (req.body ?? {}) as { pincode?: string; brand?: string }
  const brand: Brand = body.brand === "pranajiva" ? "pranajiva" : "crossfriend"

  try {
    const outcome = await issueSignupBonus({
      customerId,
      brand,
      pincode: typeof body.pincode === "string" ? body.pincode : null,
    })

    res.status(200).json({
      granted: outcome.granted,
      amountPaise: outcome.granted ? outcome.amountPaise : 0,
      /* Shown only when something was actually given. A customer who already has one, or whose area
         has no campaign, is told nothing at all — there is no good version of "you did not qualify"
         on a screen nobody asked to see. */
      message: outcome.granted
        ? `₹${(outcome.amountPaise / 100).toFixed(0)} welcome credit is in your wallet.`
        : null,
    })
  } catch (error) {
    console.error("[store/wallet/welcome] failed", error)
    res.status(500).json({ error: "Could not check that right now." })
  }
}
