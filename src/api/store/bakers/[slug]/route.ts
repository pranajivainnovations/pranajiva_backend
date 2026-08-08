import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"
import { mapBaker } from "../route"

/**
 * GET /store/bakers/:slug
 *
 * One public baker profile, plus the Medusa product ids they have published.
 *
 * Returns product IDS, not products. Ownership lives in baker_network and the product itself lives
 * in Medusa's schema — joining them in SQL would mean this route quietly bypassing Medusa's own
 * pricing, region and sales-channel logic and hand-rolling a product payload that drifts from the
 * rest of the storefront. The caller passes these ids to /store/products, which returns properly
 * priced products for the region, and gets the marketplace's channel filter applied for free.
 *
 * publication_state = 'published' is the gate. A draft or unavailable product is not listed here
 * even though the baker owns it, and (because publishing also removes it from the crossfriend sales
 * channel and sets Medusa status to 'proposed') it would not survive the /store/products call
 * either. Two independent gates, deliberately.
 *
 * 200: { baker: {...}, productIds: [...] }
 * 404: unknown slug, or a baker that is not public/active — the same response for both, since a
 *      private profile should not be distinguishable from one that does not exist.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase()
    if (!slug) {
      return res.status(404).json({ error: "Baker not found" })
    }

    const db = getBakerNetworkDbPool()
    const result = await db.query(
      `SELECT b.public_id, b.slug, b.name, b.city, b.state, b.pincode,
              b.bio, b.profile_photo_url, b.specialty_tags, b.website_url,
              b.google_rating, b.google_review_count,
              b.blue_tick, b.trust_badge, b.avg_turnaround_hours,
              COALESCE(
                (SELECT json_agg(bp.medusa_product_id ORDER BY bp.published_at DESC NULLS LAST)
                   FROM baker_network.baker_products bp
                  WHERE bp.baker_id = b.id AND bp.publication_state = 'published'),
                '[]'::json
              ) AS product_ids,
              COALESCE(
                (SELECT json_agg(json_build_object('url', bi.url, 'purpose', bi.purpose))
                   FROM baker_network.baker_images bi
                  WHERE bi.baker_id = b.id),
                '[]'::json
              ) AS images
         FROM baker_network.bakers b
        WHERE lower(b.slug) = $1 AND b.is_public AND b.is_active
        LIMIT 1`,
      [slug]
    )

    const row = result.rows[0]
    if (!row) {
      return res.status(404).json({ error: "Baker not found" })
    }

    const images: { url: string; purpose: string }[] = row.images || []
    const cover = images.find((i) => i.purpose === "cover")?.url ?? null
    const logo = images.find((i) => i.purpose === "logo" || i.purpose === "profile")?.url ?? null

    return res.status(200).json({
      baker: {
        ...mapBaker(row),
        pincode: row.pincode,
        websiteUrl: row.website_url,
        coverUrl: cover,
        photoUrl: row.profile_photo_url ?? logo,
        turnaroundHours: row.avg_turnaround_hours,
        productCount: (row.product_ids || []).length,
      },
      productIds: row.product_ids || [],
    })
  } catch (error) {
    console.error("[API /store/bakers/:slug] Error:", error)
    return res.status(500).json({ error: "Something went wrong loading this baker." })
  }
}
