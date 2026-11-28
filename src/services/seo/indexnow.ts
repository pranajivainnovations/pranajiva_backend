import type { PoolClient } from "pg"

import type { SiteSettings } from "./audit"
import { SeoError, seoDb } from "./db"
import { fetchUrl, pool } from "./fetch"
import { parsePage, parseSitemap } from "./parse"

/**
 * IndexNow — tells Bing (and Yandex, Seznam, Naver, which share submissions) the moment a public
 * page is added, materially changed or removed, instead of waiting for the next crawl.
 *
 * ── How a change gets here ─────────────────────────────────────────────────────────────────────
 * Two routes, one queue:
 *
 *   1. Publication hooks. The OPS products route (the only place PranaJiva products are written)
 *      calls queueProductChange after every create / edit / archive / restore / photo / price
 *      change. That catches products within minutes.
 *   2. The sitemap diff. Every 30 minutes the job reads the site's sitemap and compares it with the
 *      snapshot kept in seo.indexnow_urls: a new address is "added", a later lastmod is "updated",
 *      an address that left the sitemap is "removed". That catches Knowledge articles (Sanity has
 *      no hook into this backend), rituals and ingredients (code-owned, change on deploy), hubs,
 *      and anything a future content type adds — with no extra wiring, because the sitemap only
 *      ever lists public, canonical, indexable pages (drafts and noindex pages are left out of it
 *      by the storefront).
 *
 * ── What keeps it honest ───────────────────────────────────────────────────────────────────────
 *   Dedup      one row per (site, url): queueing an already-queued page just moves it back, so ten
 *              quick edits are one submission.
 *   Settle     product changes wait out the product page's ISR window (5 min) so Bing fetches the
 *              new page, not the cached old one.
 *   Cooldown   a page the sitemap says changed is not resubmitted within 6 hours of its last
 *              submission (one product edit moves the lastmod of the hubs too); the change is not
 *              lost, it goes at the next scan after the cooldown.
 *   Checked    before sending, every page is fetched: noindex or canonicalised-elsewhere pages are
 *              skipped; a new page still answering 404 waits; a removed page (404/410/redirect) is
 *              sent so engines drop it. Private and ignored paths from the site settings never go.
 *   Retry      429, 5xx, network errors and 403 (key not yet verified) back off 5 min → 15 → 45 →
 *              2¼ h → 6¾ h, then the page is marked failed for a person to retry from OPS. 400/422
 *              are permanent and fail at once.
 *   Logged     every request is a row in seo.indexnow_submissions: when, which pages, the answer.
 *   Guarded    a sitemap that fails to load, or suddenly lists under half the pages it did, is not
 *              diffed — otherwise a catalogue outage would "remove" the whole shop.
 */

const ENDPOINT = "https://api.indexnow.org/indexnow"
const MAX_BATCH = 10_000
const MAX_ATTEMPTS = 6
const SCAN_EVERY_MS = 30 * 60_000
const UPDATE_COOLDOWN_MS = 6 * 3600_000
/** The product page revalidates every 300 s; a minute more so the new version is what gets fetched. */
export const PRODUCT_SETTLE_MS = 6 * 60_000
/** First scan of a site: pages whose lastmod is this recent are sent; older ones become the baseline. */
const BASELINE_RECENT_DAYS = 7
export const INDEXNOW_KEY = /^[A-Za-z0-9-]{8,128}$/

export type Reason = "added" | "updated" | "removed" | "recent" | "manual"

interface Site {
  id: string
  slug: string
  base_url: string
  sitemap_url: string
  settings: SiteSettings
  enabled: boolean
}

interface UrlRow {
  url: string
  in_sitemap: boolean
  lastmod: Date | null
  first_seen_at: Date
  last_sent_at: Date | null
  state: "idle" | "queued" | "failed" | "skipped"
  reason: Reason | null
  attempts: number
}

/* ── sites and eligibility ───────────────────────────────────────────────────────────────────── */

const keyOf = (site: Site) => String(site.settings?.indexnowKey ?? "").trim()

async function loadSite(where: { id?: string; slug?: string }): Promise<Site | null> {
  const { rows } = await seoDb().query(
    `SELECT id, slug, base_url, sitemap_url, settings, enabled FROM seo.sites WHERE ${where.id ? "id" : "slug"} = $1`,
    [where.id ?? where.slug]
  )
  return rows[0] ?? null
}

export async function sitesWithIndexNow(): Promise<Site[]> {
  const { rows } = await seoDb().query(
    `SELECT id, slug, base_url, sitemap_url, settings, enabled FROM seo.sites
      WHERE enabled AND COALESCE(settings->>'indexnowKey', '') <> '' ORDER BY created_at`
  )
  return rows
}

const startsWithAny = (path: string, list?: string[]) => {
  const l = list ?? []
  if (l.some((p) => p.startsWith("!") && path.startsWith(p.slice(1)))) return false
  return l.some((p) => !p.startsWith("!") && path.startsWith(p))
}

/** The absolute address to submit, or null when it is not this site's, or private, or ignored. */
function eligible(site: Site, raw: string): string | null {
  try {
    const base = new URL(site.base_url)
    const u = new URL(raw, base)
    if (u.protocol !== "https:" || u.host !== base.host) return null
    if (startsWithAny(u.pathname, site.settings?.privatePaths) || startsWithAny(u.pathname, site.settings?.ignorePaths)) return null
    u.hash = ""
    return u.toString()
  } catch {
    return null
  }
}

/* ── queueing ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Put pages in the queue. Already queued: the reason is refreshed and the send moves back by the
 * settle time — that is the debounce. Returns how many were accepted (eligible).
 */
export async function queueUrls(
  site: Site,
  items: Array<{ url: string; reason: Reason }>,
  opts: { settleMs?: number; source: string }
): Promise<number> {
  const seen = new Set<string>()
  const clean = items
    .map((i) => ({ url: eligible(site, i.url), reason: i.reason }))
    .filter((i): i is { url: string; reason: Reason } => Boolean(i.url) && !seen.has(i.url!) && Boolean(seen.add(i.url!)))
  if (!clean.length) return 0
  await seoDb().query(
    `INSERT INTO seo.indexnow_urls (site_id, url, state, reason, source, queued_at, not_before, attempts, last_error)
     SELECT $1, u.url, 'queued', u.reason, $4, NOW(), NOW() + ($5 || ' milliseconds')::interval, 0, NULL
       FROM unnest($2::text[], $3::text[]) AS u(url, reason)
     ON CONFLICT (site_id, url) DO UPDATE
        SET state = 'queued', reason = EXCLUDED.reason, source = EXCLUDED.source, queued_at = NOW(),
            not_before = EXCLUDED.not_before, attempts = 0, last_error = NULL`,
    [site.id, clean.map((c) => c.url), clean.map((c) => c.reason), opts.source.slice(0, 40), String(opts.settleMs ?? 0)]
  )
  return clean.length
}

/**
 * The publication hook for PranaJiva products (api/ops/pranajiva/products). Only published
 * products are public, so: draft → draft sends nothing; going live is "added"; staying live is
 * "updated"; leaving published (archive, back to draft) is "removed"; a new handle removes the old
 * address and adds the new one. Never throws — a failure here must not fail the product save.
 */
export async function queueProductChange(
  siteSlug: string,
  before: { handle: string; status: string } | null,
  after: { handle: string; status: string } | null
): Promise<void> {
  try {
    const site = await loadSite({ slug: siteSlug })
    if (!site || !site.enabled || !keyOf(site)) return
    const wasLive = before?.status === "published"
    const isLive = after?.status === "published"
    const items: Array<{ url: string; reason: Reason }> = []
    if (isLive) items.push({ url: `/shop/${after!.handle}`, reason: wasLive && before!.handle === after!.handle ? "updated" : "added" })
    if (wasLive && (!isLive || before!.handle !== after!.handle)) items.push({ url: `/shop/${before!.handle}`, reason: "removed" })
    if (items.length) await queueUrls(site, items, { settleMs: PRODUCT_SETTLE_MS, source: "product" })
  } catch (e) {
    console.error(`[indexnow] product hook: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * The publication hook for Knowledge content: the CMS in OPS (the Sanity Studio mounted at
 * /pranajiva/knowledge) calls this from its Publish, Unpublish and Delete buttons with the pages
 * the action affects and why. Paths only, and only under /knowledge — the Studio cannot queue
 * anything else. Knowledge pages revalidate every 300 s, so the same settle as products applies.
 * A site without IndexNow answers quietly: editing an article must never show an error for this.
 */
export async function queueContentChange(
  siteSlug: string,
  items: Array<{ path: string; reason: string }>
): Promise<{ queued: number }> {
  const site = await loadSite({ slug: siteSlug })
  if (!site || !site.enabled || !keyOf(site)) return { queued: 0 }
  const allowed: Reason[] = ["added", "updated", "removed"]
  const clean = items
    .filter((i) => typeof i?.path === "string" && /^\/knowledge(\/[a-z0-9][a-z0-9-]*){0,2}$/.test(i.path) && allowed.includes(i.reason as Reason))
    .slice(0, 20)
    .map((i) => ({ url: i.path, reason: i.reason as Reason }))
  return { queued: await queueUrls(site, clean, { settleMs: PRODUCT_SETTLE_MS, source: "cms" }) }
}

/* ── the sitemap diff ────────────────────────────────────────────────────────────────────────── */

export interface ScanResult {
  total: number
  added: number
  updated: number
  removed: number
  baseline: boolean
  note: string | null
}

export async function readSitemap(site: Site): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  const first = await fetchUrl(site.sitemap_url, { timeoutMs: 30_000 })
  if (first.status !== 200) throw new SeoError(`The sitemap answered ${first.status || first.error}; nothing compared.`)
  const parsed = parseSitemap(first.body)
  const entries = [...parsed.urls]
  for (const child of parsed.children.slice(0, 50)) {
    const c = await fetchUrl(child, { timeoutMs: 30_000 })
    if (c.status !== 200) throw new SeoError(`A child sitemap (${child}) answered ${c.status || c.error}; nothing compared.`)
    entries.push(...parseSitemap(c.body).urls)
  }
  for (const e of entries) {
    const url = eligible(site, e.loc)
    if (!url) continue
    const t = e.lastmod ? Date.parse(e.lastmod) : NaN
    out.set(url, Number.isFinite(t) ? t : null)
  }
  return out
}

export async function scanSitemap(site: Site): Promise<ScanResult> {
  const db = seoDb()
  const now = Date.now()
  const result: ScanResult = { total: 0, added: 0, updated: 0, removed: 0, baseline: false, note: null }
  try {
    const live = await readSitemap(site)
    result.total = live.size

    const { rows: stateRows } = await db.query(`SELECT last_scan_at FROM seo.indexnow_state WHERE site_id = $1`, [site.id])
    result.baseline = !stateRows[0]?.last_scan_at

    const rows = (
      await db.query(
        `SELECT url, in_sitemap, lastmod, first_seen_at, last_sent_at, state, reason, attempts FROM seo.indexnow_urls WHERE site_id = $1`,
        [site.id]
      )
    ).rows as UrlRow[]
    const known = new Map(rows.map((r) => [r.url, r]))
    const before = rows.filter((r) => r.in_sitemap).length
    if (before >= 20 && live.size < before * 0.5) {
      throw new SeoError(`The sitemap lists ${live.size} pages, down from ${before}. Looks like an outage, not removals — nothing compared.`)
    }

    const queue: Array<{ url: string; reason: Reason }> = []
    const recentCutoff = now - BASELINE_RECENT_DAYS * 86_400_000

    for (const [url, lastmod] of Array.from(live.entries())) {
      const row = known.get(url)
      if (!row) {
        if (!result.baseline) queue.push({ url, reason: "added" })
        else if (lastmod != null && lastmod >= recentCutoff) queue.push({ url, reason: "recent" })
        continue
      }
      if (row.state === "queued") continue
      const since = (row.last_sent_at ?? row.first_seen_at).getTime()
      const returned = !row.in_sitemap && (row.last_sent_at == null || row.reason === "removed")
      const changed = lastmod != null && lastmod > since
      const cooling = row.last_sent_at != null && now - row.last_sent_at.getTime() < UPDATE_COOLDOWN_MS
      if (returned) queue.push({ url, reason: "added" })
      else if (changed && !cooling) queue.push({ url, reason: "updated" })
    }
    for (const row of rows) {
      if (!row.in_sitemap || live.has(row.url)) continue
      if (row.state === "queued" || row.reason === "removed") continue
      queue.push({ url: row.url, reason: "removed" })
    }

    /* Snapshot first (so a crash after it does not re-queue everything), then the queue. */
    const urls = Array.from(live.keys())
    const mods = urls.map((u) => (live.get(u) != null ? new Date(live.get(u)!).toISOString() : null))
    await db.query(
      `INSERT INTO seo.indexnow_urls (site_id, url, in_sitemap, lastmod)
       SELECT $1, u.url, TRUE, u.lastmod::timestamptz FROM unnest($2::text[], $3::text[]) AS u(url, lastmod)
       ON CONFLICT (site_id, url) DO UPDATE SET in_sitemap = TRUE, lastmod = EXCLUDED.lastmod`,
      [site.id, urls, mods]
    )
    await db.query(`UPDATE seo.indexnow_urls SET in_sitemap = FALSE WHERE site_id = $1 AND in_sitemap AND NOT (url = ANY($2::text[]))`, [site.id, urls])
    await queueUrls(site, queue, { settleMs: 0, source: result.baseline ? "first scan" : "sitemap" })
    for (const q of queue) {
      if (q.reason === "removed") result.removed++
      else if (q.reason === "updated") result.updated++
      else result.added++
    }
  } catch (e) {
    result.note = e instanceof Error ? e.message.slice(0, 300) : String(e)
    if (!(e instanceof SeoError)) console.error(`[indexnow] scan ${site.slug}: ${result.note}`)
  }
  await db.query(
    `INSERT INTO seo.indexnow_state (site_id, last_scan_at, last_scan) VALUES ($1, ${result.note ? "NULL" : "NOW()"}, $2)
     ON CONFLICT (site_id) DO UPDATE SET last_scan_at = ${result.note ? "seo.indexnow_state.last_scan_at" : "NOW()"}, last_scan = EXCLUDED.last_scan, last_try_at = NOW()`,
    [site.id, JSON.stringify(result)]
  )
  return result
}

/* ── sending ─────────────────────────────────────────────────────────────────────────────────── */

/** send, or hold back: "skipped" (not indexable, a person decides) or "wait" (retry with backoff). */
interface Verdict {
  send: boolean
  state?: "skipped" | "wait"
  why?: string
}

/** What a crawler would find at the address right now. */
export async function verify(url: string, reason: Reason): Promise<Verdict> {
  const r = await fetchUrl(url, { timeoutMs: 20_000, maxBytes: 400_000 })
  if (r.status === 0 || r.status >= 500) return { send: false, state: "wait", why: `The page did not answer (${r.status || r.error}).` }
  const redirect = r.status >= 300 && r.status < 400
  if (r.status === 404 || r.status === 410 || redirect) {
    /* A removal is exactly this. A new page answering 404 is a cache that has not caught up yet; a
       redirect will not fix itself, so it is skipped rather than retried for hours. */
    if (reason === "removed") return { send: true }
    if (redirect) return { send: false, state: "skipped", why: `Redirects to ${r.location ?? "another address"} — not submitted.` }
    return { send: false, state: "wait", why: `The page answers ${r.status} — waiting for it to go live.` }
  }
  if (r.status !== 200) return { send: false, state: "skipped", why: `The page answers ${r.status}.` }
  const page = parsePage(r.body)
  const noindex = /noindex/i.test(`${page.robotsMeta ?? ""} ${r.headers["x-robots-tag"] ?? ""}`)
  if (noindex) return reason === "removed" ? { send: true } : { send: false, state: "skipped", why: "Not indexable (noindex) — not submitted." }
  if (page.canonical) {
    const canon = new URL(page.canonical, url).toString().replace(/\/+$/, "")
    if (canon !== url.replace(/\/+$/, "")) return { send: false, state: "skipped", why: `Canonical points to ${canon} — not submitted.` }
  }
  return { send: true }
}

const backoffMs = (attempt: number) => 5 * 60_000 * Math.pow(3, Math.max(0, attempt - 1))

export interface FlushResult {
  sent: number
  skipped: number
  waiting: number
  failed: number
  status: number | null
  error: string | null
}

/** Send everything due for one site, in one request (IndexNow takes up to 10,000 per call). */
export async function flushQueue(site: Site, trigger: "auto" | "manual", opsUserId: string | null = null): Promise<FlushResult> {
  const db = seoDb()
  const out: FlushResult = { sent: 0, skipped: 0, waiting: 0, failed: 0, status: null, error: null }
  const key = keyOf(site)
  if (!key) return out

  const rows = (
    await db.query(
      `SELECT url, reason, attempts FROM seo.indexnow_urls
        WHERE site_id = $1 AND state = 'queued' AND not_before <= NOW()
        ORDER BY queued_at LIMIT ${MAX_BATCH}`,
      [site.id]
    )
  ).rows as UrlRow[]
  if (!rows.length) return out

  const postpone = async (urls: string[], why: string, attempts: Map<string, number>) => {
    for (const u of urls) {
      const n = (attempts.get(u) ?? 0) + 1
      if (n >= MAX_ATTEMPTS) {
        out.failed++
        await db.query(`UPDATE seo.indexnow_urls SET state = 'failed', attempts = $3, last_error = $4, last_tried_at = NOW() WHERE site_id = $1 AND url = $2`, [site.id, u, n, why])
      } else {
        await db.query(
          `UPDATE seo.indexnow_urls SET attempts = $3, last_error = $4, last_tried_at = NOW(), not_before = NOW() + ($5 || ' milliseconds')::interval WHERE site_id = $1 AND url = $2`,
          [site.id, u, n, why, String(backoffMs(n))]
        )
      }
    }
  }
  const attempts = new Map<string, number>(rows.map((r) => [r.url, r.attempts]))

  /* 1. Check each page. */
  const verdicts = await pool(rows, 4, async (r) => ({ row: r, v: await verify(r.url, r.reason ?? "updated") }))
  const toSend: string[] = []
  for (const { row, v } of verdicts) {
    if (v.send) toSend.push(row.url)
    else if (v.state === "skipped") {
      out.skipped++
      await db.query(`UPDATE seo.indexnow_urls SET state = 'skipped', last_error = $3, last_tried_at = NOW() WHERE site_id = $1 AND url = $2`, [site.id, row.url, v.why])
    } else {
      out.waiting++
      await postpone([row.url], v.why ?? "Not ready.", attempts)
    }
  }
  if (!toSend.length) return out

  /* 2. One request. */
  const base = new URL(site.base_url)
  const started = Date.now()
  let status = 0
  let text = ""
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: base.host, key, keyLocation: `${base.origin}/${key}.txt`, urlList: toSend }),
      signal: AbortSignal.timeout(30_000),
    })
    status = res.status
    text = (await res.text().catch(() => "")).slice(0, 500)
  } catch (e) {
    text = e instanceof Error ? e.message : String(e)
  }
  const ok = status === 200 || status === 202
  const permanent = status === 400 || status === 422
  const meaning: Record<number, string> = {
    200: "Accepted.",
    202: "Accepted; the key is still being verified.",
    400: "Bad request — the submission was malformed.",
    403: "Key not valid — the key file is missing or does not match.",
    422: "The addresses do not belong to this site, or the key does not match the host.",
    429: "Too many requests — slowing down.",
  }
  const error = ok ? null : meaning[status] ?? (status ? `IndexNow answered ${status}.` : `Could not reach IndexNow: ${text}`)
  out.status = status || null
  out.error = error

  await db.query(
    `INSERT INTO seo.indexnow_submissions (site_id, trigger, urls, url_count, status, ok, error, response, ms, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [site.id, trigger, toSend, toSend.length, status || null, ok, error, text || null, Date.now() - started, opsUserId]
  )

  if (ok) {
    out.sent = toSend.length
    await db.query(
      `UPDATE seo.indexnow_urls SET state = 'idle', attempts = 0, last_error = NULL, last_sent_at = NOW(), last_tried_at = NOW()
        WHERE site_id = $1 AND url = ANY($2::text[])`,
      [site.id, toSend]
    )
  } else if (permanent) {
    out.failed += toSend.length
    await db.query(
      `UPDATE seo.indexnow_urls SET state = 'failed', last_error = $3, last_tried_at = NOW() WHERE site_id = $1 AND url = ANY($2::text[])`,
      [site.id, toSend, error]
    )
  } else {
    await postpone(toSend, error!, attempts)
  }
  return out
}

/* ── one at a time ───────────────────────────────────────────────────────────────────────────── */

/**
 * The job and the OPS buttons both send; two at once would submit the same pages twice. A Postgres
 * advisory lock (session-level, on one pooled connection) keeps it to one, across restarts too.
 */
async function exclusive<T>(fn: () => Promise<T>): Promise<T | null> {
  const client: PoolClient = await seoDb().connect()
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtext('seo-indexnow')) AS ok`)
    if (!rows[0]?.ok) return null
    try {
      return await fn()
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('seo-indexnow'))`).catch(() => undefined)
    }
  } finally {
    client.release()
  }
}

const BUSY = "A submission is already going out. Try again in a minute."

/** The scheduled job: scan each site's sitemap when due, then send what is due. */
export async function runIndexNow(): Promise<{ sites: number; sent: number } | null> {
  return exclusive(async () => {
    let sent = 0
    const sites = await sitesWithIndexNow()
    for (const site of sites) {
      const { rows } = await seoDb().query(`SELECT last_try_at FROM seo.indexnow_state WHERE site_id = $1`, [site.id])
      const last = rows[0]?.last_try_at as Date | undefined
      if (!last || Date.now() - last.getTime() >= SCAN_EVERY_MS) await scanSitemap(site)
      sent += (await flushQueue(site, "auto")).sent
    }
    await seoDb().query(`DELETE FROM seo.indexnow_submissions WHERE created_at < NOW() - INTERVAL '90 days'`)
    return { sites: sites.length, sent }
  })
}

/* ── OPS actions ─────────────────────────────────────────────────────────────────────────────── */

async function requireSite(siteId: string): Promise<Site> {
  const site = await loadSite({ id: siteId })
  if (!site) throw new SeoError("That site does not exist.")
  if (!keyOf(site)) throw new SeoError("IndexNow is off for this site — add the key in Settings first.")
  return site
}

const summary = (f: FlushResult) =>
  [
    f.sent ? `${f.sent} sent` : null,
    f.skipped ? `${f.skipped} skipped (not indexable)` : null,
    f.waiting ? `${f.waiting} waiting to retry` : null,
    f.failed ? `${f.failed} failed` : null,
    f.error,
  ]
    .filter(Boolean)
    .join(" · ") || "Nothing was due."

/** "Submit addresses": the pages typed in OPS, checked and sent now. */
export async function submitNow(siteId: string, urls: string[], opsUserId: string): Promise<{ message: string }> {
  const site = await requireSite(siteId)
  const list = urls.map((u) => u.trim()).filter(Boolean).slice(0, 500)
  if (!list.length) throw new SeoError("Paste at least one address.")
  const accepted = await queueUrls(site, list.map((url) => ({ url, reason: "manual" as Reason })), { settleMs: 0, source: "manual" })
  if (!accepted) throw new SeoError("None of those are public addresses on this site.")
  const r = await exclusive(() => flushQueue(site, "manual", opsUserId))
  if (!r) throw new SeoError(BUSY)
  return { message: `${accepted} queued${accepted < list.length ? ` (${list.length - accepted} left out: other site, private or ignored)` : ""}. ${summary(r)}` }
}

/** "Retry": failed and skipped pages (all, or the ones given) back in the queue, sent now. */
export async function retryNow(siteId: string, urls: string[] | null, opsUserId: string): Promise<{ message: string }> {
  const site = await requireSite(siteId)
  const { rowCount } = await seoDb().query(
    `UPDATE seo.indexnow_urls SET state = 'queued', attempts = 0, not_before = NOW(), queued_at = NOW(), last_error = NULL
      WHERE site_id = $1 AND state IN ('failed', 'skipped') ${urls?.length ? "AND url = ANY($2::text[])" : ""}`,
    urls?.length ? [site.id, urls] : [site.id]
  )
  if (!rowCount) throw new SeoError("Nothing to retry.")
  const r = await exclusive(() => flushQueue(site, "manual", opsUserId))
  if (!r) throw new SeoError(BUSY)
  return { message: `${rowCount} back in the queue. ${summary(r)}` }
}

/** "Check sitemap now": the diff without waiting for the half-hour, then send. */
export async function scanNow(siteId: string, opsUserId: string): Promise<{ message: string }> {
  const site = await requireSite(siteId)
  const r = await exclusive(async () => ({ scan: await scanSitemap(site), flush: await flushQueue(site, "manual", opsUserId) }))
  if (!r) throw new SeoError(BUSY)
  if (r.scan.note) throw new SeoError(r.scan.note)
  const found = r.scan.added + r.scan.updated + r.scan.removed
  return {
    message: `${r.scan.total} pages in the sitemap; ${found ? `${r.scan.added} new, ${r.scan.updated} changed, ${r.scan.removed} removed` : "no changes"}${r.scan.baseline ? " (first scan: pages changed in the last 7 days)" : ""}. ${summary(r.flush)}`,
  }
}
