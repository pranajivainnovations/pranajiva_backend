import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"

const BAKER_FIELDS = `
  id, name, whatsapp_number, city, state, specialty_tags, trust_badge, blue_tick,
  reliability_rating, google_rating, google_review_count, avg_turnaround_hours, service_radius_km
`

const BAKER_ORDER = `
  ORDER BY trust_badge DESC, blue_tick DESC,
           reliability_rating DESC NULLS LAST, google_rating DESC NULLS LAST
  LIMIT 20
`

/**
 * GET /store/ai-studio/bakers?pincode=XXXXXX
 *
 * Real baker matching, gated by whether ops has actually launched that
 * pincode (baker_network.pincode_service_status) — a pincode with real
 * bakers in it still shows "coming soon" until explicitly onboarded, so
 * geography opens deliberately rather than by accident.
 *
 *   serviceStatus: "enabled"     — pincode is launched; bakers[] may still be empty
 *                  "coming_soon" — pincode is real (in our imported directory) but not launched yet
 *                  "unknown"     — pincode isn't in the imported India Post directory at all
 *
 * Matching, once a pincode is enabled: exact pincode / serviceable_pincodes override match first;
 * if that's empty, falls back to other active bakers in the same DISTRICT (via pincode_directory) —
 * a real-world "nearby pincodes like 201016/201009" case, without needing lat/lng distance math we
 * don't have reliable data for yet. matchType on the response tells the frontend which happened.
 *
 * Visibility requires BOTH is_active=true AND status='onboarded' — is_active is the pause/resume
 * switch, status is the CRM pipeline stage. A baker freshly promoted from a Google discovery starts
 * at status='prospect' with is_active defaulting true — without this check they'd be visible to real
 * customers before anyone has actually confirmed the partnership, which is a real business risk, not
 * just a data-hygiene nicety.
 *
 * Public — no auth required, matches the pre-existing fake route's behavior.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pincode = ((req.query.pincode as string) || "").trim()

  if (!/^\d{6}$/.test(pincode)) {
    return res.status(400).json({ error: "Please enter a valid 6-digit pincode" })
  }

  try {
    const db = getBakerNetworkDbPool()

    const statusResult = await db.query(
      `SELECT service_enabled FROM baker_network.pincode_service_status WHERE pincode = $1`,
      [pincode]
    )
    const statusRow = statusResult.rows[0]

    if (!statusRow) {
      return res.status(200).json({ bakers: [], pincode, serviceStatus: "unknown" })
    }
    if (!statusRow.service_enabled) {
      return res.status(200).json({ bakers: [], pincode, serviceStatus: "coming_soon" })
    }

    const exactResult = await db.query(
      `SELECT ${BAKER_FIELDS}
       FROM baker_network.bakers
       WHERE is_active = true AND status = 'onboarded' AND (pincode = $1 OR $1 = ANY(serviceable_pincodes))
       ${BAKER_ORDER}`,
      [pincode]
    )

    let rows = exactResult.rows
    let matchType: "exact" | "nearby" = "exact"

    if (rows.length === 0) {
      // A single pincode can genuinely span more than one district in dense areas (e.g. 201009
      // straddles both GAUTAM BUDDHA NAGAR and GHAZIABAD in this directory) — match against all of
      // them, not just whichever one a naive single-row lookup happened to return first.
      const districtResult = await db.query(
        `SELECT DISTINCT district FROM baker_network.pincode_directory WHERE pincode = $1 AND district IS NOT NULL`,
        [pincode]
      )
      const districts: string[] = districtResult.rows.map((r) => r.district)

      if (districts.length > 0) {
        const nearbyResult = await db.query(
          `SELECT ${BAKER_FIELDS}
           FROM baker_network.bakers b
           WHERE is_active = true AND status = 'onboarded'
             AND EXISTS (
               SELECT 1 FROM baker_network.pincode_directory pd
               WHERE pd.pincode = b.pincode AND pd.district = ANY($1)
             )
           ${BAKER_ORDER}`,
          [districts]
        )
        rows = nearbyResult.rows
        matchType = "nearby"
      }
    }

    const bakers = rows.map((row) => ({
      id: row.id,
      name: row.name,
      specialty: Array.isArray(row.specialty_tags) && row.specialty_tags.length
        ? row.specialty_tags.join(", ")
        : undefined,
      location: row.city ? (row.state ? `${row.city}, ${row.state}` : row.city) : undefined,
      deliveryRadius: row.service_radius_km ? `${row.service_radius_km} km` : undefined,
      turnaround: formatTurnaround(row.avg_turnaround_hours),
      rating: row.reliability_rating ?? row.google_rating ?? undefined,
      reviewCount: row.google_review_count ?? undefined,
      verified: Boolean(row.trust_badge),
      blueTick: Boolean(row.blue_tick),
      whatsapp: row.whatsapp_number ?? undefined,
    }))

    return res.status(200).json({
      bakers,
      pincode,
      serviceStatus: "enabled",
      matchType: bakers.length > 0 ? matchType : undefined,
    })
  } catch (error) {
    console.error("[API /store/ai-studio/bakers] Error:", error)
    return res.status(500).json({ error: "Something went wrong. Please try again." })
  }
}

function formatTurnaround(hours: number | null): string | undefined {
  if (!hours) return undefined
  if (hours < 24) return `${hours} hrs`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? "" : "s"}`
}
