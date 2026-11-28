import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { isValidOpsServiceKey, OPS_SERVICE_KEY_HEADER } from "../../../services/baker-portal/ops-service-auth"
import { isMissingSchema, SeoError } from "../../../services/seo/db"
import { muteFinding, saveSite, setSiteEnabled, startRun, unmuteFinding } from "../../../services/seo/monitor"

/**
 * POST /ops/seo — every write the OPS SEO Health screens make. OPS reads the `seo` tables itself.
 *
 *   run           { siteId }                     check a site now (runs in the background)
 *   site_save     { site: {...} }                add a site, or edit one (with site.id)
 *   site_enabled  { siteId, enabled }            include / leave out of the daily run
 *   mute          { siteId, fingerprint, note }  accept a finding; kept, not scored
 *   unmute        { siteId, fingerprint }
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
      default:
        res.status(400).json({ error: "Unknown action." })
    }
  } catch (e) {
    if (e instanceof SeoError) {
      res.status(400).json({ error: e.message })
      return
    }
    if (isMissingSchema(e)) {
      res.status(503).json({ error: "The SEO monitor tables are not installed yet (backend migration 1729700000000-SeoMonitor)." })
      return
    }
    console.error(`[ops/seo] ${body.action}: ${e instanceof Error ? e.message : e}`)
    res.status(500).json({ error: "Something went wrong on the server." })
  }
}
