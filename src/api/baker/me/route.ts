import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../services/baker-portal/guard"
import { getBakerNetworkDbPool } from "../../../services/baker-network/db"

/**
 * GET /baker/me
 *
 * The signed-in baker user and the organisation they act for, plus a product count for the
 * dashboard. Also the endpoint the Baker Portal uses to decide whether a stored session is still
 * good — the guard re-reads is_active on every call, so a baker deactivated in OPS is signed out
 * on their next navigation rather than whenever their week-old token happens to expire.
 *
 * Returns the profile-completeness signals the portal needs to nudge bakers toward a full listing.
 * Deliberately does NOT return blue_tick as something the baker can influence here — that is
 * granted by ops against separate criteria, and is surfaced as a read-only fact.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  try {
    const db = getBakerNetworkDbPool()
    const result = await db.query(
      `SELECT b.public_id, b.name, b.slug, b.city, b.state, b.pincode,
              b.bio, b.profile_photo_url, b.is_public, b.blue_tick, b.trust_badge,
              b.google_rating, b.google_review_count,
              b.contact_person, b.phone, b.whatsapp_number, b.email, b.address,
              b.website_url, b.avg_turnaround_hours, b.specialty_tags,
              (SELECT url FROM baker_network.baker_images bi
                WHERE bi.baker_id = b.id AND bi.purpose = 'banner' LIMIT 1) AS banner_url,
              COUNT(bp.id) FILTER (WHERE bp.publication_state = 'published')::INT AS published_products,
              COUNT(bp.id) FILTER (WHERE bp.publication_state = 'draft')::INT     AS draft_products,
              COUNT(bp.id)::INT                                                    AS total_products
         FROM baker_network.bakers b
         LEFT JOIN baker_network.baker_products bp ON bp.baker_id = b.id
        WHERE b.id = $1
        GROUP BY b.id`,
      [ctx.bakerId]
    )

    const b = result.rows[0]
    if (!b) {
      return res.status(404).json({ error: "Bakery not found." })
    }

    return res.status(200).json({
      user: {
        id: ctx.bakerUserId,
        role: ctx.role,
      },
      baker: {
        publicId: b.public_id,
        name: b.name,
        slug: b.slug,
        city: b.city,
        state: b.state,
        pincode: b.pincode,
        bio: b.bio,
        profilePhotoUrl: b.profile_photo_url,
        bannerUrl: b.banner_url,
        // Editable by the baker — see services/baker-portal/profile.ts for the allowlist. Anything
        // NOT in that list (isPublic, blueTick, trustBadge below) is returned read-only, so the
        // portal can show their standing without implying they can change it.
        contactPerson: b.contact_person,
        phone: b.phone,
        whatsappNumber: b.whatsapp_number,
        email: b.email,
        address: b.address,
        websiteUrl: b.website_url,
        avgTurnaroundHours: b.avg_turnaround_hours,
        specialtyTags: Array.isArray(b.specialty_tags) ? b.specialty_tags : [],
        isPublic: b.is_public,
        blueTick: b.blue_tick,
        trustBadge: b.trust_badge,
        rating: b.google_rating ? Number(b.google_rating) : null,
        reviewCount: b.google_review_count ?? 0,
      },
      products: {
        published: b.published_products,
        draft: b.draft_products,
        total: b.total_products,
      },
    })
  } catch (error) {
    console.error("[API /baker/me] Error:", error)
    return res.status(500).json({ error: "Something went wrong. Please try again." })
  }
}
