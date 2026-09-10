import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"

/**
 * GET /store/pincode/coverage?pincode=XXXXXX[&baker=slug]
 *
 * The single honest answer to "what can we actually do for someone at this pincode".
 *
 * ── Why this route exists ──────────────────────────────────────────────────────────────────────
 * The storefront had two separate answers to that question and they disagreed. The AI Cake Studio
 * asked /store/ai-studio/bakers and got the truth: pincodes are launched one at a time in OPS, and
 * a baker serves a pincode only if it is their own or listed in serviceable_pincodes. The product
 * pages asked a Next.js route that held a hardcoded table of thirteen 3-digit prefixes and answered
 * "yes, 2 days" for all of Mumbai, Bangalore, Chennai, Hyderabad and Kolkata — cities where no
 * baker has ever been onboarded. Its own comment said "in production, replace with delivery partner
 * API". This is that replacement.
 *
 * ── Why coverage is three states and not a boolean ─────────────────────────────────────────────
 * "Do you deliver here" collapses two genuinely different answers into one wrong one. A pincode we
 * have never launched is a different conversation from six digits that are not a pincode at all,
 * and neither is served by "no". Designing a cake is free and works anywhere in India — so the
 * caller needs to know WHICH offer to make, not merely that the best one is unavailable:
 *
 *   serviceStatus: "enabled"     — launched. bakerCount says whether anyone is actually there yet.
 *                  "coming_soon" — a real pincode in the India Post directory, not launched yet.
 *                  "unknown"     — not in the directory at all; most likely a typo.
 *
 * ── Why `baker` is optional, and what it changes ───────────────────────────────────────────────
 * Ready-to-order products are bound to a pincode through their baker — a baker is bound to a
 * pincode, so the product is too. So on a product page the real question is not "does CrossFriend
 * deliver here" but "can the baker who makes THIS cake reach this customer", and those differ
 * whenever a launched pincode has bakers but not this one. Passing ?baker= answers the narrow
 * question and still reports bakerCount, which is what lets the caller say "this baker cannot, but
 * three others can" instead of dead-ending.
 *
 * Omit it and you get the area-level answer, which is the right question on a category page.
 *
 * Read-only, public, and additive: nothing existing calls it, so it cannot regress anything.
 *
 * 200: always, for any well-formed pincode. Absence of coverage is an answer, not an error.
 * 400: not six digits.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pincode = String(req.query.pincode || "").trim()
  const bakerSlug = String(req.query.baker || "").trim().toLowerCase()

  if (!/^\d{6}$/.test(pincode)) {
    return res.status(400).json({ error: "Please enter a valid 6-digit pincode" })
  }

  try {
    const db = getBakerNetworkDbPool()

    /* Area identity first. This comes from the imported India Post directory, so it is available
       even for pincodes we will never serve — which is what makes "we don't deliver to Indiranagar
       yet" possible instead of the anonymous "we don't deliver to 560038 yet". A pincode can span
       several post offices, so DISTINCT and take the first. */
    const areaResult = await db.query(
      `SELECT DISTINCT district, state_name
         FROM baker_network.pincode_directory
        WHERE pincode = $1 AND district IS NOT NULL
        LIMIT 1`,
      [pincode]
    )
    const area = areaResult.rows[0]

    const statusResult = await db.query(
      `SELECT service_enabled FROM baker_network.pincode_service_status WHERE pincode = $1`,
      [pincode]
    )
    const statusRow = statusResult.rows[0]

    /* Not in the directory and not tracked by OPS means we have no reason to believe it is a real
       pincode. Reported as "unknown" rather than "no", because the useful next step for the
       customer is to check what they typed. */
    const serviceStatus: "enabled" | "coming_soon" | "unknown" = !statusRow
      ? area
        ? "coming_soon"
        : "unknown"
      : statusRow.service_enabled
        ? "enabled"
        : "coming_soon"

    /* Counted regardless of serviceStatus, and deliberately so: it is the difference between
       "nobody is here yet" and "this particular baker isn't".
       
       ── Why this does NOT filter on status = 'onboarded' ────────────────────────────────────────
       status tracks the commercial relationship (prospect → contacted → onboarded), and the studio's
       recommender is right to demand 'onboarded' before it puts a bakery's name forward as a partner.
       Fulfilment is a different question. Today the only baker with a published product sits at
       'contacted', in a launched pincode — so an 'onboarded' filter here would report zero coverage
       for the one product on the site a customer can actually buy, and every product page would deny
       delivery to the pincode it genuinely serves.
       
       The gate that matters for "can I receive this" is the one that already governs whether the
       product is buyable at all: a public, active baker with something published. Requiring a
       published product also keeps this count honest as a cross-sell — "three other bakers do" must
       never link to a profile with an empty shelf. */
    const countResult = await db.query(
      `SELECT COUNT(DISTINCT b.id)::int AS n
         FROM baker_network.bakers b
         JOIN baker_network.baker_products bp
           ON bp.baker_id = b.id AND bp.publication_state = 'published'
        WHERE b.is_active = true AND b.is_public = true
          AND (b.pincode = $1 OR $1 = ANY(b.serviceable_pincodes))`,
      [pincode]
    )
    const bakerCount: number = countResult.rows[0]?.n ?? 0

    let baker:
      | { slug: string; name: string; serves: boolean; turnaroundHours: number | null }
      | undefined

    if (bakerSlug) {
      /* is_public as well as is_active: a baker hidden from the public site should not be named
         back to a customer by this route, and the product carrying their slug would not be
         published either. Matching /store/bakers/:slug, an unknown or private slug simply yields
         no baker rather than a 404 — the area-level answer is still useful and still correct. */
      const bakerResult = await db.query(
        `SELECT slug, name, avg_turnaround_hours,
                (pincode = $2 OR $2 = ANY(serviceable_pincodes)) AS serves
           FROM baker_network.bakers
          WHERE lower(slug) = $1 AND is_active = true AND is_public = true
          LIMIT 1`,
        [bakerSlug, pincode]
      )
      /* No status filter here either, for the same reason as the count above — and note the
         asymmetry with bakerCount: this one does not require a published product, because the caller
         is already looking at one. */
      const row = bakerResult.rows[0]
      if (row) {
        baker = {
          slug: row.slug,
          name: row.name,
          /* A baker in a pincode OPS has not launched cannot fulfil there, whatever their own
             serviceable list claims. Launch state is the outer gate — without this the route would
             promise delivery from a baker we have not switched on. */
          serves: serviceStatus === "enabled" && Boolean(row.serves),
          /* Real, or absent. The route it replaces invented "2 Days" for cities with no baker at
             all; a null here means the caller says nothing about timing rather than guessing. */
          turnaroundHours: row.avg_turnaround_hours ?? null,
        }
      }
    }

    return res.status(200).json({
      pincode,
      serviceStatus,
      bakerCount,
      district: area?.district ?? null,
      state: area?.state_name ?? null,
      baker,
    })
  } catch (error) {
    console.error("[API /store/pincode/coverage] Error:", error)
    return res.status(500).json({ error: "Something went wrong checking this pincode." })
  }
}
