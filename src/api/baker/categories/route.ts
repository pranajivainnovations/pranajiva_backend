import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../services/baker-portal/guard"
import { BAKER_CATEGORIES } from "../../../services/baker-portal/products"

/**
 * GET /baker/categories
 *
 * The categories a baker may file a product under.
 *
 * Served from the backend rather than hardcoded in the portal so there is exactly one list. If the
 * portal kept its own copy, the day a category is added would be the day the form offers something
 * the API rejects — and the baker would get "Choose a category" for a category they just chose.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }

  return res.status(200).json({
    categories: BAKER_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
  })
}
