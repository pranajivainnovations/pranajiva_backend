import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { isValidOpsServiceKey, OPS_SERVICE_KEY_HEADER } from "../../../services/baker-portal/ops-service-auth"
import { isMissingSchema, SeoError } from "../../../services/seo/db"
import { queueContentChange, retryNow, scanNow, submitNow } from "../../../services/seo/indexnow"
import { muteFinding, saveSite, setSiteEnabled, startRun, unmuteFinding } from "../../../services/seo/monitor"

/**
 * POST /ops/seo — every write the OPS SEO Health screens make. OPS reads the `seo` tables itself.
 *
 *   run           { siteId }                     check a site now (runs in the background)
 *   site_save     { site: {...} }                add a site, or edit one (with site.id)
 *   site_enabled  { siteId, enabled }            include / leave out of the daily run
 *   mute          { siteId, fingerprint, note }  accept a finding; kept, not scored
 *   unmute        { siteId, fingerprint }
 *   indexnow_submit { siteId, urls[] }          check and send these pages to IndexNow now
 *   indexnow_retry  { siteId, urls?[] }         failed/skipped pages (all, or these) back in the queue, sent now
 *   indexnow_content { site, items[{path,reason}] } the OPS CMS published/unpublished/deleted Knowledge pages
 *   indexnow_scan   { siteId }                  compare the sitemap now instead of at the half-hour, then send
 */

const UUID = /^[0-9a-f-]{36}$/i

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }
  const body = (req.body ?? {}) as Record<string, any>
  const opsUserId = String(body.opsUserId ?? "")
  if (!UUID.test(opsUserId)) {
    res.status(400).json({ error: "opsUserId is required." })
    return
  }
  const siteId = () => {
    const v = String(body.siteId ?? "")
    if (!UUID.test(v)) throw new SeoError("siteId is missing.")
    return v
  }

  try {
    switch (body.action) {
      case "run":
        res.json(await startRun(siteId(), "manual", opsUserId))
        return
      case "site_save":
        res.json(await saveSite((body.site ?? {}) as Record<string, unknown>, opsUserId))
        return
      case "site_enabled":
        await setSiteEnabled(siteId(), Boolean(body.enabled))
        res.json({ ok: true })
        return
      case "mute":
        await muteFinding(siteId(), String(body.fingerprint ?? ""), String(body.note ?? ""), opsUserId)
        res.json({ ok: true })
        return
      case "unmute":
        await unmuteFinding(siteId(), String(body.fingerprint ?? ""))
        res.json({ ok: true })
        return
      case "indexnow_submit":
        res.json(await submitNow(siteId(), Array.isArray(body.urls) ? body.urls.map(String) : [], opsUserId))
        return
      case "indexnow_retry":
        res.json(await retryNow(siteId(), Array.isArray(body.urls) && body.urls.length ? body.urls.map(String) : null, opsUserId))
        return
      case "indexnow_content":
        res.json(await queueContentChange(String(body.site ?? ""), Array.isArray(body.items) ? body.items : []))
        return
      case "indexnow_scan":
        res.json(await scanNow(siteId(), opsUserId))
        return
      default:
        res.status(400).json({ error: "Unknown action." })
    }
  } catch (e) {
    if (e instanceof SeoError) {
      res.status(400).json({ error: e.message })
      return
    }
    if (isMissingSchema(e)) {
      res.status(503).json({ error: String(body.action).startsWith("indexnow") ? "The IndexNow tables are not installed yet (backend migration 1729900000000-IndexNow)." : "The SEO monitor tables are not installed yet (backend migration 1729700000000-SeoMonitor)." })
      return
    }
    console.error(`[ops/seo] ${body.action}: ${e instanceof Error ? e.message : e}`)
    res.status(500).json({ error: "Something went wrong on the server." })
  }
}
