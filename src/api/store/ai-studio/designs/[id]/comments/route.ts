import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { addComment, listComments } from "../../../../../../services/ai-studio-social/comments-service"
import { SocialActionError } from "../../../../../../services/ai-studio-social/social-errors"

/**
 * GET /store/ai-studio/designs/:id/comments
 *
 * Public — no auth required. If a valid _medusa_jwt is present, comments
 * belonging to that customer are marked isOwn: true.
 *
 * Query: page? (default 1), limit? (default 20, max 50)
 * Response 200: { comments: [...], pagination: {...} }
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const designId = req.params.id
  const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1)
  const limit = Math.min(parseInt((req.query.limit as string) || "20", 10), 50)
  const requestingCustomerId = req.user?.customer_id

  try {
    const result = await listComments(designId, page, limit, requestingCustomerId)
    return res.status(200).json(result)
  } catch (error) {
    console.error("[API /store/ai-studio/designs/:id/comments] GET Error:", error)
    // Graceful fallback — never break the comment list UI
    return res.status(200).json({
      comments: [],
      pagination: { page: 1, limit: 20, total: 0, hasMore: false },
    })
  }
}

/**
 * POST /store/ai-studio/designs/:id/comments
 *
 * Adds a comment. Auth required.
 * Body: { content: string }
 * Response 200: { success: true, comment: {...}, commentCount: number }
 * Response 400: empty/too-long content
 * Response 401: not authenticated
 * Response 404: design not found
 * Response 429: rate limited
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.user?.customer_id

  if (!customerId) {
    return res.status(401).json({
      success: false,
      error: "Authentication required. Please log in to comment.",
      code: "AUTH_REQUIRED",
    })
  }

  const designId = req.params.id
  const { content } = req.body as { content?: string }

  try {
    const result = await addComment(designId, customerId, content || "")
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    if (error instanceof SocialActionError) {
      return res.status(error.status).json({ success: false, error: error.message, code: error.code })
    }
    console.error("[API /store/ai-studio/designs/:id/comments] POST Error:", error)
    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again.",
      code: "INTERNAL_ERROR",
    })
  }
}
