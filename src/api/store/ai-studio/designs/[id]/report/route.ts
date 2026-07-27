import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { reportTarget } from "../../../../../../services/ai-studio-social/reports-service"
import { SocialActionError } from "../../../../../../services/ai-studio-social/social-errors"

/**
 * POST /store/ai-studio/designs/:id/report
 *
 * Reports the design itself, or — if `commentId` is given in the body —
 * a specific comment on that design. Auth required. One report per
 * (reporter, target); after 3 total reports the target is auto-hidden
 * (comment → status 'hidden', design → is_public false) pending review.
 *
 * Body: { commentId?: string, reason?: string }
 * Response 200: { success: true, reported: true }
 * Response 401: not authenticated
 * Response 404: design/comment not found
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const reporterCustomerId = req.user?.customer_id

  if (!reporterCustomerId) {
    return res.status(401).json({
      success: false,
      error: "Authentication required.",
      code: "AUTH_REQUIRED",
    })
  }

  const designId = req.params.id
  const { commentId, reason } = req.body as { commentId?: string; reason?: string }

  try {
    const result = await reportTarget({ designId, commentId, reporterCustomerId, reason })
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    if (error instanceof SocialActionError) {
      return res.status(error.status).json({ success: false, error: error.message, code: error.code })
    }
    console.error("[API /store/ai-studio/designs/:id/report] Error:", error)
    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again.",
      code: "INTERNAL_ERROR",
    })
  }
}
