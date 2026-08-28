import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getAiStudioDbPool } from "../../../../../services/ai-image/db"

/**
 * GET /store/ai-studio/designs/:id
 *
 * One public design, for its own indexable page at /ai-cake-studio/gallery/[slug].
 *
 * The showcase route already returns this shape, but only in pages of up to 50 and only in a fixed
 * sort order — fetching a specific design through it would mean walking the pagination until the id
 * turned up. Hence a direct lookup.
 *
 * ── Why the visibility rules are repeated rather than shared ────────────────────────────────────
 * `status = 'active' AND is_public = true AND image_url` is the same gate the showcase applies. It
 * is restated here deliberately: this endpoint is reachable by id alone, so if the two ever drift,
 * the failure mode is a design the customer marked private being served to anyone who guesses or
 * retains its URL. A design that has been unpublished must 404 here even though it was public when
 * the URL was first shared and indexed.
 *
 * `siblings` returns a few other designs for the same occasion, so the page has somewhere to send a
 * visitor and so the gallery gains internal links between its own pages rather than every design
 * hanging off the index alone.
 *
 * Response 200: { design: {...}, siblings: [...] }
 * Response 404: { message } — unknown id, or one that is no longer public.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params

  try {
    const requestingCustomerId = req.user?.customer_id ?? null
    const db = getAiStudioDbPool()

    /**
     * Accepts a full id or a leading fragment of one.
     *
     * The storefront slug ends in the first 8 hex characters of the id — enough to be unique across
     * any catalogue this will realistically hold, and short enough that the readable part of the
     * URL stays readable. A full uuid is matched exactly; anything shorter is matched as a prefix.
     *
     * Only hex is allowed through, so the LIKE pattern can never carry a wildcard: a fragment
     * containing % or _ would otherwise match designs the caller did not ask for.
     */
    const isHexFragment = /^[0-9a-f]{4,32}$/i.test(id)
    const isFullId = /^[0-9a-f-]{36}$/i.test(id)
    if (!isFullId && !isHexFragment) {
      return res.status(404).json({ message: "Design not found" })
    }

    const idPredicate = isFullId
      ? "cd.id = $1"
      : "REPLACE(cd.id::text, '-', '') LIKE $1 || '%'"

    const result = await db.query(
      `SELECT
        cd.id, cd.image_url, cd.prompt, cd.compiled_prompt, cd.style, cd.occasion, cd.flavor,
        cd.weight, cd.tiers, cd.shape,
        cd.view_count, cd.save_count, cd.comment_count,
        cd.created_at,
        (dl.id IS NOT NULL) AS is_liked
      FROM ai_studio.cake_designs cd
      LEFT JOIN ai_studio.design_likes dl
        ON dl.design_id = cd.id AND dl.customer_id = $2
      WHERE ${idPredicate}
        AND cd.status = 'active'
        AND cd.is_public = true
        AND cd.image_url IS NOT NULL
        AND cd.image_url != ''
      LIMIT 1`,
      [isFullId ? id : id.toLowerCase(), requestingCustomerId]
    )

    const row = result.rows[0]
    if (!row) {
      return res.status(404).json({ message: "Design not found" })
    }

    const design = {
      id: row.id,
      imageUrl: row.image_url,
      prompt: row.prompt,
      compiledPrompt: row.compiled_prompt || undefined,
      style: row.style,
      occasion: row.occasion,
      flavor: row.flavor,
      weight: row.weight || undefined,
      tiers: row.tiers || undefined,
      shape: row.shape || undefined,
      likeCount: row.save_count || 0,
      commentCount: row.comment_count || 0,
      viewCount: row.view_count || 0,
      isLiked: Boolean(row.is_liked),
      createdAt: row.created_at,
    }

    // Same occasion where there is one, otherwise simply the most recent. Excludes the design
    // itself so a page never links to where the reader already is.
    const siblingResult = await db.query(
      `SELECT cd.id, cd.image_url, cd.prompt, cd.occasion
       FROM ai_studio.cake_designs cd
       WHERE cd.id != $1::uuid
         AND cd.status = 'active'
         AND cd.is_public = true
         AND cd.image_url IS NOT NULL
         AND cd.image_url != ''
         AND ($2::text IS NULL OR cd.occasion = $2)
       ORDER BY cd.save_count DESC NULLS LAST, cd.created_at DESC
       LIMIT 6`,
      [row.id, row.occasion || null]
    )

    return res.status(200).json({
      design,
      siblings: siblingResult.rows.map((s) => ({
        id: s.id,
        imageUrl: s.image_url,
        prompt: s.prompt,
        occasion: s.occasion,
      })),
    })
  } catch (error) {
    console.error("[Design API] Error:", error)
    // A 500 here would be indexed as a broken page. The gallery index still works, so send the
    // crawler somewhere honest instead.
    return res.status(404).json({ message: "Design not found" })
  }
}
