import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"

/**
 * GET /store/pincode/lookup?pincode=XXXXXX
 *
 * Resolves a pincode to its city (district) and state, so an address form can fill in what the
 * pincode already determines instead of asking the customer to type it.
 *
 * Reads baker_network.pincode_directory — the official India Post Pincode Directory (data.gov.in),
 * already imported for baker matching. Same table, same rows, different question: /ai-studio/bakers
 * asks "which district is this, so I can find bakers near it", this asks "which district is this, so
 * I can name it". Nothing here is fetched from an external service at request time.
 *
 * Deliberately NOT scoped to serviceable pincodes. Serviceability lives in
 * pincode_service_status and gates ordering; a billing address, or a gift shipped outside our
 * delivery area, still needs a correct city and state. Callers that care about serviceability ask
 * /ai-studio/bakers, which is the route that owns that question.
 *
 * Sits under /store/pincode rather than /store/ai-studio because checkout needs it too — it isn't
 * an AI Studio concern.
 *
 * Response 200: { success: true, data: { city, state } }
 * Response 200: { success: false, error }  — valid format, not in the directory
 * Response 400: { success: false, error }  — malformed pincode
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pincode = ((req.query.pincode as string) || "").trim()

  if (!/^\d{6}$/.test(pincode)) {
    return res
      .status(400)
      .json({ success: false, error: "Please enter a valid 6-digit pincode" })
  }

  try {
    const db = getBakerNetworkDbPool()

    // The directory is one row per POST OFFICE, so a pincode has several rows — and in dense areas
    // they don't all agree on the district (201009 straddles Gautam Buddha Nagar and Ghaziabad).
    // The district covering the most offices is the best single answer for a "City" field; the
    // customer can overwrite it, and it's a label rather than something we route on.
    //
    // The literal string 'NA' has to be filtered as hard as NULL: 715 rows in the imported directory
    // carry it in both district and state_name, and without this the form would confidently fill in
    // a state called "Na". Where a pincode has a mix, the real rows win; where every one of its rows
    // is 'NA' (about 100 pincodes) nothing matches and the customer types the fields themselves,
    // which is the honest outcome.
    const result = await db.query(
      `SELECT TRIM(district) AS district,
              TRIM(state_name) AS state_name,
              COUNT(*) AS office_count
         FROM baker_network.pincode_directory
        WHERE pincode = $1
          AND UPPER(TRIM(COALESCE(district, ''))) NOT IN ('', 'NA')
          AND UPPER(TRIM(COALESCE(state_name, ''))) NOT IN ('', 'NA')
        GROUP BY 1, 2
        ORDER BY office_count DESC, district ASC
        LIMIT 1`,
      [pincode]
    )

    const row = result.rows[0]

    if (!row) {
      return res
        .status(200)
        .json({ success: false, error: "We couldn't recognise that pincode." })
    }

    return res.status(200).json({
      success: true,
      data: {
        city: toDisplayCase(row.district),
        state: toDisplayCase(row.state_name),
      },
    })
  } catch (error) {
    console.error("[API /store/pincode/lookup] Error:", error)
    // The address form is perfectly usable with the customer typing city and state themselves, so a
    // lookup failure is a missing convenience, not an error worth blocking checkout over.
    return res
      .status(200)
      .json({ success: false, error: "Pincode lookup is unavailable right now." })
  }
}

/** Words that stay lowercase inside a name, e.g. "NCT OF DELHI" -> "NCT of Delhi". */
const MINOR_WORDS = new Set(["of", "and", "the"])

/**
 * The India Post source file is entirely upper case, which reads as shouting in a form field. Only
 * touches strings that are fully upper case — if a future import preserves proper casing, that
 * casing is left exactly as it is.
 */
function toDisplayCase(value: string): string {
  if (value !== value.toUpperCase()) {
    return value
  }

  return value
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && MINOR_WORDS.has(word)) {
        return word
      }
      // Dotted initialisms are districts named after people — the directory has Y.S.R. (Kadapa) and
      // S.A.S Nagar. Title casing produces "Y.s.r.", so these keep the source's upper case.
      if (word.includes(".")) {
        return word.toUpperCase()
      }
      // Hyphenated and apostrophed names capitalise on each part: "pathanamthitta-east".
      return word.replace(/(^|[-'])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase())
    })
    .join(" ")
}
