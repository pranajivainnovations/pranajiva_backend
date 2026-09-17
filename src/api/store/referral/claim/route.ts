import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import type { Brand } from "../../../../services/wallet/ledger"
import { claimReferralCode } from "../../../../services/wallet/referrals"

/**
 * POST /store/referral/claim — "I was referred by this code."
 *
 * Called by a storefront immediately after a sign-in that created an account, with the code the
 * visitor arrived carrying. The customer is whoever the token says; the code is the only input.
 *
 * ── Why every refusal is a 200 ─────────────────────────────────────────────────────────────────
 * None of the ways this can decline is an error on the caller's part. A mistyped code, a customer
 * who already has a referrer, somebody pasting their own code — each is an ordinary outcome that the
 * storefront wants to name to the customer, and returning 4xx for them would put a stream of red
 * lines in the logs for a feature working exactly as designed. The status field carries the answer.
 *
 * ── Why this cannot pay anybody ────────────────────────────────────────────────────────────────
 * It writes one edge in wallet.referrals and touches no ledger entry. Money moves in GS-5.2, from a
 * delivered order after its return window, and nothing a browser calls can bring that forward.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id

  if (!customerId) {
    res.status(401).json({ error: "Sign in first.", code: "AUTH_REQUIRED" })
    return
  }

  const body = (req.body ?? {}) as { code?: unknown; brand?: unknown }
  const code = typeof body.code === "string" ? body.code : ""

  if (!code.trim()) {
    res.status(400).json({ error: "A referral code is required." })
    return
  }

  const brand: Brand = body.brand === "pranajiva" ? "pranajiva" : "crossfriend"

  try {
    const result = await claimReferralCode({ customerId, code, brand })

    /**
     * What the customer is told.
     *
     * A cycle reads as "already attributed" on purpose. It is a refusal that only ever fires on a
     * deliberate attempt to construct one, and the honest description — "that would make a loop in
     * our referral graph" — explains the mechanism to the one person who wants to defeat it while
     * meaning nothing to anybody else.
     */
    const message: Record<ClaimStatus, string> = {
      attributed: "Thanks — we've credited your friend for bringing you here.",
      unknown_code: "We don't recognise that code. Check it and try again.",
      already_ordered: "Referral codes are for new customers, and you've already ordered with us.",
      already_attributed: "You've already been referred by someone.",
      self_referral: "That's your own code — share it with someone else.",
      would_create_cycle: "You've already been referred by someone.",
      unknown_customer: "We couldn't find that account.",
    }

    res.status(200).json({
      status: result.status,
      attributed: result.status === "attributed",
      message: message[result.status],
    })
  } catch (error) {
    console.error("[store/referral/claim] failed", error)
    res.status(500).json({ error: "Could not record that referral right now." })
  }
}

type ClaimStatus = Awaited<ReturnType<typeof claimReferralCode>>["status"]
