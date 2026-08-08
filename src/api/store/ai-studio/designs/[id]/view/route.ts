import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getAiStudioDbPool } from "../../../../../../services/ai-image/db"

/**
 * POST /store/ai-studio/designs/:id/view
 *
 * Records that a design was actually looked at — opened in the lightbox, not merely rendered as a
 * thumbnail in a grid the visitor scrolled past.
 *
 * `cake_designs.view_count` has existed since the original schema but nothing ever wrote to it, so
 * every row sat at 0. That mattered beyond reporting: the showcase gallery's default "Popular" sort is
 * `save_count DESC, view_count DESC, created_at DESC`, and with likes in the low single digits the
 * whole ordering was effectively falling through to creation date. The inspiration gallery — the thing
 * meant to show newcomers the best work — was showing them the newest work instead.
 *
 * Public and unauthenticated: views are counted for anonymous visitors too, which is most of them.
 * Fire-and-forget by design — a failed count must never surface to the customer, so this always
 * answers 204 and swallows its own errors.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const designId = req.params.id

  try {
    const db = getAiStudioDbPool()
    await db.query(
      `UPDATE ai_studio.cake_designs
         SET view_count = view_count + 1
       WHERE id = $1 AND status = 'active'`,
      [designId]
    )
  } catch (error) {
    // Deliberately not surfaced — a lost view is worth nothing, a broken lightbox is worth a lot.
    console.error("[API /store/ai-studio/designs/:id/view] Error:", error)
  }

  return res.status(204).send("")
}
