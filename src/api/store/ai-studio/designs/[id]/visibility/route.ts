import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getAiStudioDbPool } from "../../../../../../services/ai-image/db"

/**
 * POST /store/ai-studio/designs/:id/visibility   { isPublic: boolean }
 *
 * Publishes a design to the community gallery, or pulls it back out.
 *
 * Designs are private on creation (see migration 1723200000000) because their prompts routinely carry
 * the recipient's name and occasion. This is the deliberate act that makes one public.
 *
 * Auth required, and scoped to the owner: the UPDATE matches on customer_id as well as id, so one
 * customer can never publish — or unpublish — somebody else's design. A design that exists but isn't
 * theirs is reported as 404 rather than 403, so this can't be used to probe which ids exist.
 *
 * Response 200: { isPublic }
 * Response 400: bad body
 * Response 401: not logged in
 * Response 404: no such design belonging to this customer
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.user?.customer_id
  if (!customerId) {
    return res.status(401).json({ error: "Please log in to change who can see this design." })
  }

  const body = req.body as { isPublic?: unknown }
  if (typeof body?.isPublic !== "boolean") {
    return res.status(400).json({ error: "isPublic must be true or false" })
  }

  try {
    const db = getAiStudioDbPool()
    const result = await db.query(
      `UPDATE ai_studio.cake_designs
          SET is_public = $1, updated_at = NOW()
        WHERE id = $2 AND customer_id = $3 AND status = 'active'
        RETURNING is_public`,
      [body.isPublic, req.params.id, customerId]
    )

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Design not found." })
    }

    return res.status(200).json({ isPublic: result.rows[0].is_public })
  } catch (error) {
    console.error("[API /store/ai-studio/designs/:id/visibility] Error:", error)
    return res.status(500).json({ error: "Could not update this design. Please try again." })
  }
}
