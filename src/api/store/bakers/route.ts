import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../services/baker-network/db"

/**
 * GET /store/bakers
 *
 * Public baker directory. No auth — this is a browse surface.
 *
 * Visibility requires BOTH is_public AND is_active, matching the rule /store/ai-studio/bakers
 * already applies. is_public is ops's deliberate "this profile is ready to be seen" switch;
 * is_active is the pause/resume control. A baker who has been onboarded but whose profile is still
 * a stub must not appear, which is why the default for is_public is false and stays false until
 * someone decides otherwise.
 *
 * Query: ?q= (name/city search) &city= &limit= &page=
 * 200: { bakers: [...], pagination: { page, limit, total, hasMore } }
 *
 * Ordering puts featured_priority first, then the trust signals, then name — so an empty search
 * returns a deliberately curated page rather than whatever the planner felt like returning.
 *
 * Never errors out to the caller: a directory that 500s takes a nav link down with it, whereas an
 * empty page degrades to "no bakers yet", which is also the honest state of a new marketplace.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const q = ((req.query.q as string) || "").trim()
    const city = ((req.query.city as string) || "").trim()
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "24", 10) || 24, 1), 50)
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1)
    const offset = (page - 1) * limit

    const conditions = ["b.is_public", "b.is_active"]
    const params: unknown[] = []

    if (q) {
      params.push(`%${q}%`)
      conditions.push(`(b.name ILIKE $${params.length} OR b.city ILIKE $${params.length})`)
    }
    if (city) {
      params.push(city)
      conditions.push(`b.city = $${params.length}`)
    }

    const where = conditions.join(" AND ")

    // Total and page in ONE round trip. Two queries would double this endpoint's cost against a
    // database that is a full network hop away — see the window function below.
    params.push(limit, offset)
    const db = getBakerNetworkDbPool()
    const result = await db.query(
      `SELECT b.public_id, b.slug, b.name, b.city, b.state,
              b.bio, b.profile_photo_url, b.specialty_tags,
              b.google_rating, b.google_review_count,
              b.blue_tick, b.trust_badge,
              COUNT(*) OVER () AS total_count,
              (SELECT COUNT(*) FROM baker_network.baker_products bp
                WHERE bp.baker_id = b.id AND bp.publication_state = 'published') AS product_count
         FROM baker_network.bakers b
        WHERE ${where}
        ORDER BY b.featured_priority DESC,
                 b.trust_badge DESC,
                 b.blue_tick DESC,
                 b.google_rating DESC NULLS LAST,
                 b.name ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const total = result.rows.length ? parseInt(result.rows[0].total_count, 10) : 0

    return res.status(200).json({
      bakers: result.rows.map(mapBaker),
      pagination: { page, limit, total, hasMore: offset + result.rows.length < total },
    })
  } catch (error) {
    console.error("[API /store/bakers] Error:", error)
    return res.status(200).json({
      bakers: [],
      pagination: { page: 1, limit: 24, total: 0, hasMore: false },
    })
  }
}

export function mapBaker(row: Record<string, any>) {
  return {
    id: row.public_id,
    slug: row.slug,
    name: row.name,
    city: row.city,
    state: row.state,
    bio: row.bio,
    photoUrl: row.profile_photo_url,
    specialties: Array.isArray(row.specialty_tags) ? row.specialty_tags : [],
    // Google's rating is the only one we have — presented as-is rather than dressed up as a
    // CrossFriend rating we have not earned the data for.
    rating: row.google_rating != null ? Number(row.google_rating) : null,
    reviewCount: row.google_review_count ?? 0,
    blueTick: Boolean(row.blue_tick),
    trustBadge: Boolean(row.trust_badge),
    productCount: parseInt(row.product_count ?? "0", 10),
  }
}
