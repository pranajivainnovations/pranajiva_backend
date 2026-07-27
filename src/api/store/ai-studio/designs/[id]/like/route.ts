import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { toggleLike } from "../../../../../../services/ai-studio-social/likes-service"
import { SocialActionError } from "../../../../../../services/ai-studio-social/social-errors"

/**
 * POST /store/ai-studio/designs/:id/like
 *
 * Toggles a like on a design for the authenticated customer.
 * Auth: requires valid _medusa_jwt (same pattern as /ai-studio/generate).
 *
 * Response 200: { liked: boolean, likeCount: number }
 * Response 401: not authenticated
 * Response 404: design not found
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.user?.customer_id

  if (!customerId) {
    return res.status(401).json({
      success: false,
      error: "Authentication required. Please log in to like a design.",
      code: "AUTH_REQUIRED",
    })
  }

  const designId = req.params.id

  try {
    const result = await toggleLike(designId, customerId)
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    if (error instanceof SocialActionError) {
      return res.status(error.status).json({ success: false, error: error.message, code: error.code })
    }
    console.error("[API /store/ai-studio/designs/:id/like] Error:", error)
    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again.",
      code: "INTERNAL_ERROR",
    })
  }
}
