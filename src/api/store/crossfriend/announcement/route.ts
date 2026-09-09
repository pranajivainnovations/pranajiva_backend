import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"

/**
 * GET /store/crossfriend/announcement
 *
 * The one announcement that is live right now, or nothing.
 *
 * No auth: this is a banner shown to every visitor, so every field in it is public by definition.
 * Nothing private may ever be added to crossfriend.announcements for that reason — the OPS composer
 * that writes it says the same.
 *
 * ── Why the database decides what is live, not the storefront ──────────────────────────────────
 * The window could be evaluated after fetching, and it would be wrong within a day: the storefront
 * caches this response, so a banner whose end time passed during the cache window would keep
 * rendering until something happened to refresh it. Filtering here means an expired announcement is
 * gone at the next revalidation at the latest, and NOW() is the database's clock rather than
 * whatever the web container thinks the time is.
 *
 * ── Why only one ──────────────────────────────────────────────────────────────────────────────
 * There is one banner slot. Returning a list would push the choice of which to show into the
 * storefront, where it would be made differently by whoever wrote that component. The newest live
 * announcement wins, which is also what a person means when they publish a second one.
 *
 * Failure returns 200 with `{ announcement: null }`, matching the settings route. A database blip
 * hides a banner for a minute; it never takes down the page the banner sits on.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  try {
    const pool = getBakerNetworkDbPool()

    const { rows } = await pool.query(
      `SELECT id, title, body, image_url, theme, cta_label, cta_url
         FROM crossfriend.announcements
        WHERE is_published
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at   IS NULL OR ends_at   >  NOW())
        ORDER BY created_at DESC
        LIMIT 1`
    )

    const row = rows[0]
    if (!row) {
      res.json({ announcement: null })
      return
    }

    res.json({
      announcement: {
        id: row.id,
        title: row.title,
        body: row.body ?? "",
        imageUrl: row.image_url ?? null,
        theme: row.theme ?? "purple",
        ctaLabel: row.cta_label ?? null,
        ctaUrl: row.cta_url ?? null,
      },
    })
  } catch (error) {
    // Includes "the table does not exist yet", which is the state between deploying this and
    // running the migration. The storefront renders nothing and nobody sees an error.
    console.error("[announcement] could not read", error)
    res.json({ announcement: null })
  }
}
