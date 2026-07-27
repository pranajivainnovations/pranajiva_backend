import { getAiStudioDbPool } from "../ai-image/db"
import { SocialActionError } from "./social-errors"

/**
 * Toggles a like for (designId, customerId). Likes reuse the existing
 * `cake_designs.save_count` column — the storefront already displays that
 * column as "likeCount", so this does not introduce a second counter.
 *
 * The delete-then-insert-or-update is wrapped in a transaction so a rapid
 * double-tap can't race past the UNIQUE(design_id, customer_id) constraint.
 */
export async function toggleLike(
  designId: string,
  customerId: string
): Promise<{ liked: boolean; likeCount: number }> {
  const db = getAiStudioDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    const design = await client.query(
      `SELECT id FROM ai_studio.cake_designs WHERE id = $1 AND status = 'active'`,
      [designId]
    )
    if (design.rowCount === 0) {
      throw new SocialActionError("Design not found.", "NOT_FOUND", 404)
    }

    const removed = await client.query(
      `DELETE FROM ai_studio.design_likes WHERE design_id = $1 AND customer_id = $2 RETURNING id`,
      [designId, customerId]
    )

    let liked: boolean

    if ((removed.rowCount ?? 0) > 0) {
      liked = false
      await client.query(
        `UPDATE ai_studio.cake_designs SET save_count = GREATEST(save_count - 1, 0) WHERE id = $1`,
        [designId]
      )
    } else {
      liked = true
      await client.query(
        `INSERT INTO ai_studio.design_likes (design_id, customer_id) VALUES ($1, $2)
         ON CONFLICT (design_id, customer_id) DO NOTHING`,
        [designId, customerId]
      )
      await client.query(
        `UPDATE ai_studio.cake_designs SET save_count = save_count + 1 WHERE id = $1`,
        [designId]
      )
    }

    const counted = await client.query(
      `SELECT save_count FROM ai_studio.cake_designs WHERE id = $1`,
      [designId]
    )

    await client.query("COMMIT")
    return { liked, likeCount: counted.rows[0]?.save_count ?? 0 }
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}
