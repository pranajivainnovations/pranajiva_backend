import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { deleteComment } from "../../../../../../../services/ai-studio-social/comments-service"
import { SocialActionError } from "../../../../../../../services/ai-studio-social/social-errors"

/**
 * DELETE /store/ai-studio/designs/:id/comments/:commentId
 *
 * Soft-deletes a comment (status → 'deleted'). Only the comment's own
 * author may delete it. Auth required.
 *
 * Response 200: { success: true, commentCount: number }
 * Response 401: not authenticated
 * Response 404: comment not found / not owned by this customer
 */
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.user?.customer_id

  if (!customerId) {
    return res.status(401).json({
      success: false,
      error: "Authentication required.",
      code: "AUTH_REQUIRED",
    })
  }

  const designId = req.params.id
  const commentId = req.params.commentId

  try {
    const result = await deleteComment(designId, commentId, customerId)
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    if (error instanceof SocialActionError) {
      return res.status(error.status).json({ success: false, error: error.message, code: error.code })
    }
    console.error("[API /store/ai-studio/designs/:id/comments/:commentId] DELETE Error:", error)
    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again.",
      code: "INTERNAL_ERROR",
    })
  }
}
