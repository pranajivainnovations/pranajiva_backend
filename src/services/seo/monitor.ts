import { auditSite, type Finding, type SiteSettings } from "./audit"
import { SeoError, seoDb } from "./db"

/**
 * SEO Health Monitor — runs, storage and site settings. The checks themselves are in audit.ts.
 *
 * A run is started (daily job or "Run now" in OPS), crawls in the background, and writes one row in
 * seo.runs, its findings in seo.findings and a fresh page snapshot in seo.pages. "New" means a
 * fingerprint the site's previous finished run did not have; muted fingerprints are kept but left
 * out of the score.
 */

export interface SiteRow {
  id: string
  slug: string
  name: string
  base_url: string
  sitemap_url: string
  feed_url: string | null
  settings: SiteSettings
  enabled: boolean
}

/** Errors cost more than warnings; info costs nothing. Grouped findings count once. */
export function scoreOf(findings: Array<{ severity: string }>): number {
  const e = findings.filter((f) => f.severity === "error").length
  const w = findings.filter((f) => f.severity === "warning").length
  return Math.max(0, 100 - 8 * e - 2 * w)
}

/** A run left "running" for this long died with a restart. */
const STALE_MS = 30 * 60_000

export async function getSite(siteId: string): Promise<SiteRow> {
  const { rows } = await seoDb().query(`SELECT * FROM seo.sites WHERE id = $1`, [siteId])
  if (!rows[0]) throw new SeoError("That site does not exist.")
  return rows[0]
}

/** Start a run in the background. Refuses if this site already has one going. */
export async function startRun(siteId: string, trigger: "schedule" | "manual", opsUserId: string | null): Promise<{ runId: string }> {
  const db = seoDb()
  const site = await getSite(siteId)
  const { rows: busy } = await db.query(
    `SELECT id FROM seo.runs WHERE site_id = $1 AND status = 'running' AND started_at > NOW() - ($2 || ' milliseconds')::interval LIMIT 1`,
    [siteId, String(STALE_MS)]
  )
  if (busy[0]) throw new SeoError(`${site.name} is already being checked. Refresh in a minute or two.`)
  await db.query(
    `UPDATE seo.runs SET status = 'failed', finished_at = NOW(), error = 'Interrupted (server restarted).'
      WHERE site_id = $1 AND status = 'running'`,
    [siteId]
  )
  const { rows } = await db.query(
    `INSERT INTO seo.runs (site_id, trigger, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [siteId, trigger, opsUserId]
  )
  const runId = rows[0].id as string
  void execute(site, runId).catch((e) => console.error(`[seo] run ${runId} crashed: ${e?.message ?? e}`))
  return { runId }
}

async function execute(site: SiteRow, runId: string): Promise<void> {
  const db = seoDb()
  try {
    const result = await auditSite({
      baseUrl: site.base_url,
      sitemapUrl: site.sitemap_url,
      feedUrl: site.feed_url,
      settings: site.settings ?? {},
    })

    /* First-seen dates carry over from the previous finished run, so "new" means new. */
    const { rows: prevRun } = await db.query(
      `SELECT id FROM seo.runs WHERE site_id = $1 AND status = 'done' AND id <> $2 ORDER BY started_at DESC LIMIT 1`,
      [site.id, runId]
    )
    const firstSeen = new Map<string, Date>()
    if (prevRun[0]) {
      const { rows } = await db.query(`SELECT fingerprint, first_seen_at FROM seo.findings WHERE run_id = $1`, [prevRun[0].id])
      for (const r of rows) firstSeen.set(r.fingerprint, r.first_seen_at)
    }
    const { rows: muteRows } = await db.query(`SELECT fingerprint FROM seo.mutes WHERE site_id = $1`, [site.id])
    const muted = new Set(muteRows.map((r) => r.fingerprint as string))

    const live = result.findings.filter((f) => !muted.has(f.fingerprint))
    const isNew = (f: Finding) => Boolean(prevRun[0]) && !firstSeen.has(f.fingerprint)
    const counts = {
      error: live.filter((f) => f.severity === "error").length,
      warning: live.filter((f) => f.severity === "warning").length,
      info: live.filter((f) => f.severity === "info").length,
      muted: result.findings.length - live.length,
      newErrors: live.filter((f) => f.severity === "error" && isNew(f)).length,
      newWarnings: live.filter((f) => f.severity === "warning" && isNew(f)).length,
      fixed: prevRun[0] ? Array.from(firstSeen.keys()).filter((fp) => !result.findings.some((f) => f.fingerprint === fp)).length : 0,
    }

    const client = await db.connect()
    try {
      await client.query("BEGIN")
      for (const f of result.findings) {
        await client.query(
          `INSERT INTO seo.findings (run_id, site_id, check_id, category, severity, fingerprint, title, detail, fix, urls, evidence, first_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, NOW()))`,
          [runId, site.id, f.checkId, f.category, f.severity, f.fingerprint, f.title, f.detail, f.fix, f.urls,
           f.evidence && Object.keys(f.evidence).length ? JSON.stringify(f.evidence) : null, firstSeen.get(f.fingerprint) ?? null]
        )
      }
      await client.query(`DELETE FROM seo.pages WHERE site_id = $1`, [site.id])
      for (const p of result.pages) {
        await client.query(
          `INSERT INTO seo.pages (site_id, url, status, in_sitemap, title, description, canonical, robots, h1_count, words, schema_types, inlinks, load_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (site_id, url) DO NOTHING`,
          [site.id, p.url, p.status, p.inSitemap, p.title, p.description, p.canonical, p.robots, p.h1Count, p.words, p.schemaTypes, p.inlinks, p.loadMs]
        )
      }
      await client.query(
        `UPDATE seo.runs SET status = 'done', finished_at = NOW(), pages_checked = $2, score = $3, counts = $4, summary = $5 WHERE id = $1`,
        [runId, result.pages.length, scoreOf(live), JSON.stringify(counts), JSON.stringify(result.summary)]
      )
      await client.query("COMMIT")
    } catch (e) {
      await client.query("ROLLBACK")
      throw e
    } finally {
      client.release()
    }
  } catch (e) {
    await db.query(`UPDATE seo.runs SET status = 'failed', finished_at = NOW(), error = $2 WHERE id = $1`, [
      runId,
      e instanceof Error ? e.message.slice(0, 500) : String(e),
    ])
  }
}

/** The daily job: every enabled site, one after another (gentle on the server), then tidy up. */
export async function runAllSites(): Promise<{ started: number }> {
  const db = seoDb()
  const { rows } = await db.query(`SELECT id FROM seo.sites WHERE enabled ORDER BY created_at`)
  let started = 0
  for (const r of rows) {
    try {
      const { runId } = await startRun(r.id, "schedule", null)
      started += 1
      /* Wait for this site before the next: one crawl at a time. */
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 15_000))
        const { rows: st } = await db.query(`SELECT status FROM seo.runs WHERE id = $1`, [runId])
        if (st[0]?.status !== "running") break
      }
    } catch (e) {
      console.error(`[seo] daily run for site ${r.id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  /* 90 days of history; findings cascade. */
  await db.query(`DELETE FROM seo.runs WHERE started_at < NOW() - INTERVAL '90 days'`)
  return { started }
}

/* ── site settings ────────────────────────────────────────────────────────────────────────── */

const SLUG = /^[a-z0-9][a-z0-9-]{1,46}$/

function httpsUrl(v: unknown, label: string, optional = false): string | null {
  const s = String(v ?? "").trim()
  if (!s && optional) return null
  try {
    const u = new URL(s)
    if (u.protocol !== "https:") throw new Error()
    return u.toString().replace(/\/$/, "")
  } catch {
    throw new SeoError(`${label} must be a full https:// address.`)
  }
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\n,]+/))
    .map((x) => String(x).trim())
    .filter((x) => x.startsWith("/"))
    .slice(0, 50)

export async function saveSite(input: Record<string, unknown>, opsUserId: string): Promise<{ id: string }> {
  const name = String(input.name ?? "").trim().slice(0, 120)
  if (!name) throw new SeoError("Give the site a name.")
  const baseUrl = httpsUrl(input.baseUrl, "Website address")!
  const sitemapUrl = httpsUrl(input.sitemapUrl || `${baseUrl}/sitemap.xml`, "Sitemap address")!
  const feedUrl = httpsUrl(input.feedUrl, "Merchant feed address", true)
  const productPath = String(input.productPath ?? "").trim()
  if (productPath) {
    try {
      new RegExp(productPath)
    } catch {
      throw new SeoError("The product page pattern is not a valid pattern.")
    }
  }
  const settings: SiteSettings = {
    productPath,
    claimCheck: Boolean(input.claimCheck),
    maxPages: Math.max(10, Math.min(Number(input.maxPages) || 400, 2000)),
    thinWords: Math.max(0, Math.min(Number(input.thinWords) || 250, 2000)),
    privatePaths: list(input.privatePaths),
    ignorePaths: list(input.ignorePaths),
    listingPaths: list(input.listingPaths),
  }
  const db = seoDb()
  if (input.id) {
    const { rowCount } = await db.query(
      `UPDATE seo.sites SET name = $2, base_url = $3, sitemap_url = $4, feed_url = $5, settings = $6, updated_at = NOW() WHERE id = $1`,
      [input.id, name, baseUrl, sitemapUrl, feedUrl, JSON.stringify(settings)]
    )
    if (!rowCount) throw new SeoError("That site does not exist.")
    return { id: String(input.id) }
  }
  const slug = String(input.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 46)
  if (!SLUG.test(slug)) throw new SeoError("Give the site a short name with letters or numbers.")
  /* OPS serves /seo/live (the CrossFriend live audit) next to /seo/<slug>. */
  if (slug === "live") throw new SeoError(`"live" is reserved — choose another name.`)
  try {
    const { rows } = await db.query(
      `INSERT INTO seo.sites (slug, name, base_url, sitemap_url, feed_url, settings, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [slug, name, baseUrl, sitemapUrl, feedUrl, JSON.stringify(settings), opsUserId]
    )
    return { id: rows[0].id }
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new SeoError(`A site called "${slug}" already exists.`)
    throw e
  }
}

export async function setSiteEnabled(siteId: string, enabled: boolean): Promise<void> {
  await seoDb().query(`UPDATE seo.sites SET enabled = $2, updated_at = NOW() WHERE id = $1`, [siteId, enabled])
}

export async function muteFinding(siteId: string, fingerprint: string, note: string, opsUserId: string): Promise<void> {
  if (!fingerprint) throw new SeoError("Nothing to mute.")
  await seoDb().query(
    `INSERT INTO seo.mutes (site_id, fingerprint, note, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (site_id, fingerprint) DO UPDATE SET note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = NOW()`,
    [siteId, fingerprint.slice(0, 1000), note.slice(0, 500) || null, opsUserId]
  )
}

export async function unmuteFinding(siteId: string, fingerprint: string): Promise<void> {
  await seoDb().query(`DELETE FROM seo.mutes WHERE site_id = $1 AND fingerprint = $2`, [siteId, fingerprint])
}
