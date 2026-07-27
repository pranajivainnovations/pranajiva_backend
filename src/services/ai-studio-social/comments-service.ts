import { getAiStudioDbPool } from "../ai-image/db"
import { getDisplayName } from "./display-name"
import { SocialActionError } from "./social-errors"

const MAX_COMMENT_LENGTH = 500
const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_MAX_PER_WINDOW = 5

export interface CommentOutput {
  id: string
  content: string
  customerName: string
  createdAt: string
  isOwn: boolean
}

export async function listComments(
  designId: string,
  page: number,
  limit: number,
  requestingCustomerId?: string
): Promise<{ comments: CommentOutput[]; pagination: { page: number; limit: number; total: number; hasMore: boolean } }> {
  const db = getAiStudioDbPool()
  const offset = (page - 1) * limit

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM ai_studio.design_comments WHERE design_id = $1 AND status = 'active'`,
    [designId]
  )
  const total = parseInt(countResult.rows[0]?.total || "0", 10)

  const result = await db.query(
    `SELECT dc.id, dc.customer_id, dc.content, dc.created_at, c.first_name, c.last_name
     FROM ai_studio.design_comments dc
     LEFT JOIN customer c ON c.id = dc.customer_id
     WHERE dc.design_id = $1 AND dc.status = 'active'
     ORDER BY dc.created_at DESC
     LIMIT $2 OFFSET $3`,
    [designId, limit, offset]
  )

  const comments: CommentOutput[] = result.rows.map((row) => ({
    id: row.id,
    content: row.content,
    customerName: getDisplayName({
      id: row.customer_id,
      first_name: row.first_name,
      last_name: row.last_name,
    }),
    createdAt: row.created_at,
    isOwn: requestingCustomerId != null && row.customer_id === requestingCustomerId,
  }))

  return {
    comments,
    pagination: { page, limit, total, hasMore: offset + limit < total },
  }
}

export async function addComment(
  designId: string,
  customerId: string,
  rawContent: string
): Promise<{ comment: CommentOutput; commentCount: number }> {
  const content = rawContent.trim()

  if (!content) {
    throw new SocialActionError("Comment cannot be empty.", "INVALID_REQUEST", 400)
  }
  if (content.length > MAX_COMMENT_LENGTH) {
    throw new SocialActionError(
      `Comment must be ${MAX_COMMENT_LENGTH} characters or less.`,
      "INVALID_REQUEST",
      400
    )
  }

  const db = getAiStudioDbPool()

  const design = await db.query(
    `SELECT id FROM ai_studio.cake_designs WHERE id = $1 AND status = 'active'`,
    [designId]
  )
  if (design.rowCount === 0) {
    throw new SocialActionError("Design not found.", "NOT_FOUND", 404)
  }

  const recent = await db.query(
    `SELECT COUNT(*) as count FROM ai_studio.design_comments
     WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '${RATE_LIMIT_WINDOW_SECONDS} seconds'`,
    [customerId]
  )
  if (parseInt(recent.rows[0]?.count || "0", 10) >= RATE_LIMIT_MAX_PER_WINDOW) {
    throw new SocialActionError(
      "You're commenting too fast. Please slow down a little.",
      "RATE_LIMITED",
      429
    )
  }

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const inserted = await client.query(
      `INSERT INTO ai_studio.design_comments (design_id, customer_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [designId, customerId, content]
    )

    await client.query(
      `UPDATE ai_studio.cake_designs SET comment_count = comment_count + 1 WHERE id = $1`,
      [designId]
    )

    const counted = await client.query(
      `SELECT comment_count FROM ai_studio.cake_designs WHERE id = $1`,
      [designId]
    )

    await client.query("COMMIT")

    const customer = await db.query(
      `SELECT first_name, last_name FROM customer WHERE id = $1`,
      [customerId]
    )

    return {
      comment: {
        id: inserted.rows[0].id,
        content: inserted.rows[0].content,
        customerName: getDisplayName({
          id: customerId,
          first_name: customer.rows[0]?.first_name,
          last_name: customer.rows[0]?.last_name,
        }),
        createdAt: inserted.rows[0].created_at,
        isOwn: true,
      },
      commentCount: counted.rows[0]?.comment_count ?? 0,
    }
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

export async function deleteComment(
  designId: string,
  commentId: string,
  customerId: string
): Promise<{ commentCount: number }> {
  const db = getAiStudioDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    const updated = await client.query(
      `UPDATE ai_studio.design_comments SET status = 'deleted', updated_at = NOW()
       WHERE id = $1 AND design_id = $2 AND customer_id = $3 AND status = 'active'
       RETURNING id`,
      [commentId, designId, customerId]
    )

    if (updated.rowCount === 0) {
      throw new SocialActionError(
        "Comment not found or you don't have permission to delete it.",
        "NOT_FOUND",
        404
      )
    }

    await client.query(
      `UPDATE ai_studio.cake_designs SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1`,
      [designId]
    )

    const counted = await client.query(
      `SELECT comment_count FROM ai_studio.cake_designs WHERE id = $1`,
      [designId]
    )

    await client.query("COMMIT")
    return { commentCount: counted.rows[0]?.comment_count ?? 0 }
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}
