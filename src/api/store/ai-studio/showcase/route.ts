import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getAiStudioDbPool } from "../../../../services/ai-image/db"

/**
 * GET /store/ai-studio/showcase
 *
 * Public, paginated feed of previously generated cake designs that customers
 * opted to keep public — used to power the "inspiration" showcase gallery.
 * No authentication required.
 *
 * Query params:
 *   occasion?: string
 *   style?: string
 *   sort?: "popular" | "recent" | "trending"  (default: "popular")
 *   limit?: number   (default 12, max 50)
 *   page?: number    (default 1)
 *
 * Response 200:
 *   {
 *     designs: [{ id, imageUrl, prompt, compiledPrompt?, style, occasion, flavor,
 *                 likeCount, commentCount, viewCount, isLiked, createdAt }],
 *     pagination: { page, limit, total, hasMore }
 *   }
 *
 * `isLiked` reflects the requesting customer's own like — false for
 * anonymous callers or designs they haven't liked. No auth is required to
 * call this route; a valid _medusa_jwt just personalizes that one field.
 *
 * Never errors out to the caller — on any DB failure it returns an empty
 * page so the storefront gallery degrades gracefully instead of crashing.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const requestingCustomerId = req.user?.customer_id ?? null
    const occasion = (req.query.occasion as string) || null
    const style = (req.query.style as string) || null
    const sort = (req.query.sort as string) || "popular"
    const limit = Math.min(parseInt((req.query.limit as string) || "12", 10), 50)
    const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1)
    const offset = (page - 1) * limit

    const db = getAiStudioDbPool()

    // Build WHERE conditions
    const conditions: string[] = [
      "status = 'active'",
      "is_public = true",
      "image_url IS NOT NULL",
      "image_url != ''",
    ]
    const params: unknown[] = []
    let paramIndex = 1

    if (occasion) {
      conditions.push(`occasion = $${paramIndex}`)
      params.push(occasion)
      paramIndex++
    }

    if (style) {
      conditions.push(`style = $${paramIndex}`)
      params.push(style)
      paramIndex++
    }

    // Trending: only last 7 days
    if (sort === "trending") {
      conditions.push(`created_at > NOW() - INTERVAL '7 days'`)
    }

    const whereClause = conditions.join(" AND ")

    // Sort order
    let orderClause: string
    switch (sort) {
      case "recent":
        orderClause = "created_at DESC"
        break
      case "trending":
        orderClause = "view_count DESC, save_count DESC, created_at DESC"
        break
      case "popular":
      default:
        orderClause = "save_count DESC, view_count DESC, created_at DESC"
        break
    }

    // Count total
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM ai_studio.cake_designs WHERE ${whereClause}`,
      params
    )
    const total = parseInt(countResult.rows[0]?.total || "0", 10)

    // Fetch designs — LEFT JOIN against the requesting customer's own likes
    // (customerIdParamIndex) so we can report isLiked without a second query.
    const customerIdParamIndex = paramIndex
    const limitParamIndex = paramIndex + 1
    const offsetParamIndex = paramIndex + 2

    const result = await db.query(
      `SELECT
        cd.id, cd.image_url, cd.prompt, cd.compiled_prompt, cd.style, cd.occasion, cd.flavor,
        cd.view_count, cd.save_count, cd.comment_count,
        cd.created_at,
        (dl.id IS NOT NULL) AS is_liked
      FROM ai_studio.cake_designs cd
      LEFT JOIN ai_studio.design_likes dl
        ON dl.design_id = cd.id AND dl.customer_id = $${customerIdParamIndex}
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      [...params, requestingCustomerId, limit, offset]
    )

    const designs = result.rows.map((row) => ({
      id: row.id,
      imageUrl: row.image_url,
      prompt: row.prompt,
      // Public by design — visitors can copy the exact prompt that produced
      // this image and reuse it elsewhere. Older designs predate this column
      // and will simply have none to show.
      compiledPrompt: row.compiled_prompt || undefined,
      style: row.style,
      occasion: row.occasion,
      flavor: row.flavor,
      likeCount: row.save_count || 0,
      commentCount: row.comment_count || 0,
      viewCount: row.view_count || 0,
      isLiked: Boolean(row.is_liked),
      createdAt: row.created_at,
    }))

    return res.status(200).json({
      designs,
      pagination: {
        page,
        limit,
        total,
        hasMore: offset + limit < total,
      },
    })
  } catch (error) {
    console.error("[Showcase API] Error:", error)

    // Graceful fallback — never crash the gallery
    return res.status(200).json({
      designs: [],
      pagination: { page: 1, limit: 12, total: 0, hasMore: false },
    })
  }
}
