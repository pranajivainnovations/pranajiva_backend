import { getAiStudioDbPool } from "../ai-image/db"
import { SocialActionError } from "./social-errors"

const AUTO_HIDE_THRESHOLD = 3

export async function reportTarget(params: {
  designId: string
  commentId?: string
  reporterCustomerId: string
  reason?: string
}): Promise<{ reported: true }> {
  const { designId, commentId, reporterCustomerId, reason } = params
  const db = getAiStudioDbPool()

  if (commentId) {
    const comment = await db.query(
      `SELECT id FROM ai_studio.design_comments WHERE id = $1 AND design_id = $2 AND status = 'active'`,
      [commentId, designId]
    )
    if (comment.rowCount === 0) {
      throw new SocialActionError("Comment not found.", "NOT_FOUND", 404)
    }
  } else {
    const design = await db.query(`SELECT id FROM ai_studio.cake_designs WHERE id = $1`, [designId])
    if (design.rowCount === 0) {
      throw new SocialActionError("Design not found.", "NOT_FOUND", 404)
    }
  }

  // One report per (reporter, target) — ON CONFLICT DO NOTHING infers the
  // matching partial unique index (uq_reports_*_reporter) automatically.
  await db.query(
    `INSERT INTO ai_studio.reports (design_id, comment_id, reporter_customer_id, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [commentId ? null : designId, commentId || null, reporterCustomerId, reason || null]
  )

  if (commentId) {
    const { rows } = await db.query(
      `SELECT COUNT(*) as count FROM ai_studio.reports WHERE comment_id = $1`,
      [commentId]
    )
    if (parseInt(rows[0]?.count || "0", 10) >= AUTO_HIDE_THRESHOLD) {
      await db.query(`UPDATE ai_studio.design_comments SET status = 'hidden' WHERE id = $1`, [commentId])
    }
  } else {
    const { rows } = await db.query(
      `SELECT COUNT(*) as count FROM ai_studio.reports WHERE design_id = $1`,
      [designId]
    )
    if (parseInt(rows[0]?.count || "0", 10) >= AUTO_HIDE_THRESHOLD) {
      await db.query(`UPDATE ai_studio.cake_designs SET is_public = false WHERE id = $1`, [designId])
    }
  }

  return { reported: true }
}
