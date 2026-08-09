import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../services/baker-portal/guard"
import { listBakerProductTypes } from "../../../services/baker-portal/products"

/**
 * GET /baker/product-types
 *
 * The product kinds a baker may choose when creating a listing — active CrossFriend types only.
 *
 * Sits behind the baker guard rather than reusing the public /store/crossfriend/taxonomy because
 * this is the portal's own form data: it should be unavailable to an unauthenticated caller for the
 * same reason every other /baker route is, and it returns only what the form needs rather than the
 * whole occasion matrix.
 *
 * Served from the taxonomy, so a type added in OPS is immediately offerable to bakers with no
 * deploy — and Pranajiva's product types, which share the same Medusa table, can never appear here.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }

  try {
    const types = await listBakerProductTypes()
    return res.status(200).json({ types })
  } catch (error) {
    console.error("[API /baker/product-types] Error:", error)
    return res.status(500).json({ error: "Couldn't load product kinds. Please try again." })
  }
}
