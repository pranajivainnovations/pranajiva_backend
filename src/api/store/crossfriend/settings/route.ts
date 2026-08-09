import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"

/**
 * GET /store/crossfriend/settings
 *
 * The public contact details and social handles the storefront renders — WhatsApp number, support
 * phone and email, grievance officer, social profile URLs.
 *
 * No auth: every one of these values is printed on the website already. Nothing private may be
 * added to crossfriend.site_settings for that reason — it is a public table by definition, and the
 * OPS screen that writes it says so.
 *
 * Empty values are returned as empty strings rather than omitted, so the storefront can treat
 * "configured but blank" and "not configured" the same way: don't render that link. A social icon
 * pointing at "" is a dead link on every page.
 *
 * Failure returns 200 with an empty object, matching the taxonomy route. The storefront falls back
 * to its compiled-in defaults, so a database blip removes the ability to UPDATE contact details for
 * a minute — it does not blank the contact details themselves.
 */

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  try {
    const pool = getBakerNetworkDbPool()
    const result = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM crossfriend.site_settings ORDER BY key`
    )

    const settings: Record<string, string> = {}
    for (const row of result.rows) {
      settings[row.key] = row.value ?? ""
    }

    res.status(200).json({ settings })
  } catch (error) {
    console.error("[store/crossfriend/settings] failed", error)
    res.status(200).json({ settings: {} })
  }
}
