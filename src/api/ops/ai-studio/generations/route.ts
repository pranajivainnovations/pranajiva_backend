import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { findCustomerByMobile } from "../../../../services/ops/find-customer"
import {
  getAllowance,
  getStudioLimits,
  grantGenerations,
} from "../../../../services/ai-studio/allowance"
import { getWalletDbPool } from "../../../../services/wallet/db"

/**
 * Who has run out of Studio generations, and giving somebody more.
 *
 * ── Why this exists instead of a price ─────────────────────────────────────────────────────────
 * The original design charged ₹10 for a generation once the free ones were gone. That is parked:
 * nobody has decided how a pack would be sold, and a half-built payment for compute is worse than
 * none. What replaced it is smaller and, for now, better — when somebody runs out, the ops team can
 * see it and give them more after actually talking to them.
 *
 * That trade is deliberate. A price scales without anybody present; a conversation does not. But a
 * conversation with the customer who has designed nine cakes is the most valuable thing happening on
 * this product right now, and this route makes it possible rather than deferring it behind a
 * checkout flow nobody has specified.
 *
 * ── Why the list is ordered by what was used, not by who is loudest ────────────────────────────
 * The GET below ranks customers by how much of their allowance is gone. Somebody at the ceiling is
 * either the best prospect on the platform or the most expensive visitor on it, and the difference
 * is a phone call — so the job of this list is to surface them before they simply stop coming back.
 */

/**
 * GET /ops/ai-studio/generations — the usage list, busiest first.
 *
 * Optional ?mobile= narrows to one customer, which is what support does while the person is on the
 * phone.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  try {
    const limits = await getStudioLimits()

    if (typeof req.query.mobile === "string" && req.query.mobile.trim()) {
      const found = await findCustomerByMobile(req.query.mobile)
      if (!found.customerId) {
        res.status(found.status).json({ error: found.error })
        return
      }
      const allowance = await getAllowance(found.customerId)
      res.status(200).json({
        limits,
        customers: [{ customerId: found.customerId, ...allowance, ...(await profile(found.customerId)) }],
      })
      return
    }

    /**
     * One query for everybody, rather than the allowance function per customer.
     *
     * getAllowance answers precisely for one person and is what the generate route uses. Calling it
     * in a loop for a list would be one round trip per row, so the same arithmetic is expressed once
     * here in SQL. The two must agree — the harness checks a customer both ways for that reason.
     */
    const { rows } = await getWalletDbPool().query(
      `WITH used AS (
         SELECT customer_id, COUNT(*)::int n
           FROM ai_studio.generations
          WHERE status = 'completed' OR ($1::boolean AND status = 'failed')
          GROUP BY customer_id
       ),
       granted AS (
         SELECT customer_id, COALESCE(SUM(amount), 0)::int n
           FROM ai_studio.generation_grants
          GROUP BY customer_id
       )
       SELECT c.id                              AS "customerId",
              c.email,
              c.phone,
              COALESCE(u.n, 0)                  AS used,
              COALESCE(g.n, 0)                  AS "grantedExtra",
              $2::int + COALESCE(g.n, 0)        AS total,
              GREATEST(0, $2::int + COALESCE(g.n, 0) - COALESCE(u.n, 0)) AS remaining
         FROM used u
         JOIN public.customer c ON c.id = u.customer_id AND c.deleted_at IS NULL
         LEFT JOIN granted g ON g.customer_id = u.customer_id
        ORDER BY remaining ASC, used DESC
        LIMIT 100`,
      [limits.chargeFailed, limits.freeSignedIn]
    )

    res.status(200).json({ limits, customers: rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[ops/ai-studio/generations GET]", message)
    res.status(500).json({ error: "Could not read Studio usage." })
  }
}

/**
 * POST /ops/ai-studio/generations — give a customer more generations.
 *
 * Body: { mobile | customerId, amount, reason, opsUserId }
 *
 * The reason and the author are required here and again by the database, because this is the one
 * allowance in the system that no rule can explain afterwards — only the person who granted it can.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    customerId?: string
    mobile?: string
    amount?: number
    reason?: string
    opsUserId?: string
  }

  const amount = Number(body.amount ?? 0)
  const reason = String(body.reason ?? "").trim()

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    res.status(400).json({ error: "How many generations? Enter a whole number above zero." })
    return
  }
  if (amount > 500) {
    /* The database refuses this too. Caught here so the operator gets a sentence rather than a
       constraint name — a typed 5000 is a slip, not an intention. */
    res.status(400).json({ error: "That is more than 500. Grant a smaller number." })
    return
  }
  if (reason.length < 3) {
    res.status(400).json({
      error: "A reason is required — it is the only record of why these were given.",
    })
    return
  }
  if (!body.opsUserId) {
    res.status(400).json({ error: "opsUserId is required — every grant is attributed." })
    return
  }

  try {
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

    await grantGenerations({ customerId, amount, reason, createdBy: body.opsUserId })

    /* Read back rather than added up here, so what ops is shown is the same number the Studio will
       enforce on this customer's next request. */
    const allowance = await getAllowance(customerId)

    res.status(200).json({ granted: true, customerId, amount, allowance })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[ops/ai-studio/generations POST]", message)
    res.status(500).json({ error: "The grant was not written." })
  }
}

/** Enough to recognise the person on the phone, and nothing more. */
async function profile(customerId: string) {
  try {
    const { rows } = await getWalletDbPool().query(
      `SELECT email, phone FROM public.customer WHERE id = $1`,
      [customerId]
    )
    return { email: rows[0]?.email ?? null, phone: rows[0]?.phone ?? null }
  } catch {
    return { email: null, phone: null }
  }
}
