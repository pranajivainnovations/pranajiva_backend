import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { grantCredit, type Brand } from "../../../../services/wallet/ledger"
import { findCustomerByMobile } from "../../../../services/ops/find-customer"

/**
 * POST /ops/wallet/grant — credit given by hand.
 *
 * ── What this is for ───────────────────────────────────────────────────────────────────────────
 * Everything else in the wallet pays out because a rule said so: an order was placed, a delivery
 * cleared its return window, a customer signed up during a campaign. This is the one that exists
 * because a person decided — an apology for a cake that arrived late, a goodwill gesture, a
 * thank-you, a customer who should have had a bonus and did not. Those cases are real and
 * unpredictable, and a system with no path for them grows one anyway, badly, in somebody's SQL client.
 *
 * ── Why a reason and a named person are mandatory ──────────────────────────────────────────────
 * The ledger has refused a manual grant without both since the day it was created, and this route
 * simply cannot get around that. Every other entry can be explained by replaying a rule; this one can
 * only be explained by the person who made it, so their name and their reason are the explanation.
 * A quarter from now, "₹500 to this customer" with nothing beside it is indistinguishable from fraud.
 *
 * ── Why there is no budget check ───────────────────────────────────────────────────────────────
 * The budgets and grant caps bound automatic mechanics, which pay without anybody watching. This one
 * has somebody watching by definition — that is what makes it manual. What protects it is that it is
 * attributed, visible in the customer's own history, and counted in the liability figure like every
 * other rupee owed.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    customerId?: string
    mobile?: string
    brand?: string
    amountPaise?: number
    reason?: string
    expiryDays?: number | null
    opsUserId?: string
  }

  const brand: Brand = body.brand === "pranajiva" ? "pranajiva" : "crossfriend"
  const amountPaise = Number(body.amountPaise ?? 0)
  const reason = String(body.reason ?? "").trim()

  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    res.status(400).json({ error: "amountPaise must be a whole number above zero." })
    return
  }
  if (!reason) {
    res.status(400).json({ error: "A reason is required — it is the only record of why this was given." })
    return
  }
  if (!body.opsUserId) {
    res.status(400).json({ error: "opsUserId is required — every manual grant is attributed." })
    return
  }

  try {
    /**
     * Found by mobile when an id was not given.
     *
     * Ops knows customers by the number they signed in with; nobody has a customer id to hand. The
     * lookup matches the synthetic email the OTP flow mints, which is the only thing tying a mobile
     * to a customer row.
     */
    let customerId = body.customerId ?? null

    if (!customerId && body.mobile) {
      const found = await findCustomerByMobile(body.mobile)
      if (!found.customerId) {
        res.status(found.status).json({ error: found.error })
        return
      }
      customerId = found.customerId
    }

    if (!customerId) {
      res.status(400).json({ error: "Give a customerId or a mobile number." })
      return
    }

    const expiryDays = Number(body.expiryDays ?? 0)
    const expiresAt =
      expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000) : null

    const entry = await grantCredit({
      customerId,
      entryType: "manual_grant",
      amountPaise,
      brand,
      reason,
      createdBy: body.opsUserId,
      expiresAt,
    })

    if (!entry) {
      res.status(500).json({ error: "The grant was not written." })
      return
    }

    res.status(200).json({
      granted: true,
      customerId,
      amountPaise,
      entryId: entry.id,
      expiresAt,
    })
  } catch (error) {
    console.error("[ops/wallet/grant] failed", error)
    res.status(500).json({ error: "Could not write that grant." })
  }
}
