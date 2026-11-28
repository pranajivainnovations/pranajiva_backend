import { fetchUrl, imageLoads, pool, type Fetched } from "./fetch"
import {
  parseFeed,
  parsePage,
  parseRobots,
  parseSitemap,
  robotsBlocks,
  typesOf,
  type ParsedPage,
} from "./parse"

/**
 * One audit of one website: crawl the sitemap, follow internal links one step, read the robots
 * file and the Merchant feed, and turn everything found into findings grouped by cause.
 *
 * Nothing here is specific to a website. What differs between sites — which paths are products,
 * which are private, whether health wording is checked — comes from the site's settings row.
 */

export interface SiteSettings {
  /** Regex on the path for product pages, e.g. "^/shop/[^/]+$". Empty: no product checks. */
  productPath?: string
  /** Check product text and the feed for health wording Google tends to disapprove. */
  claimCheck?: boolean
  /** Most pages fetched per run, sitemap and linked pages together. */
  maxPages?: number
  /** Pages under this many words are reported as thin. */
  thinWords?: number
  /** Paths that must never be in the sitemap or indexed (account, cart, app screens). A path
   *  starting with "!" is an exception: "!/tracker/guide" keeps that public page out of the rule. */
  privatePaths?: string[]
  /** Paths the crawler never follows (APIs, assets, feeds). */
  ignorePaths?: string[]
  /** Pages that must always link to at least one product (shop, main collections). Needs productPath. */
  listingPaths?: string[]
}

export interface SiteInput {
  baseUrl: string
  sitemapUrl: string
  feedUrl: string | null
  settings: SiteSettings
}

export type Severity = "error" | "warning" | "info"
export type Category = "indexing" | "sitemap" | "metadata" | "structured-data" | "links" | "images" | "feed" | "content" | "speed" | "ai"

export interface Finding {
  checkId: string
  category: Category
  severity: Severity
  /** Stable across runs: the same problem keeps the same fingerprint, which is how "new" and mutes work. */
  fingerprint: string
  title: string
  detail: string
  fix: string
  urls: string[]
  evidence?: Record<string, unknown>
}

export interface PageSnapshot {
  url: string
  status: number
  inSitemap: boolean
  title: string | null
  description: string | null
  canonical: string | null
  robots: string | null
  h1Count: number | null
  words: number | null
  schemaTypes: string[]
  inlinks: number
  loadMs: number
}

export interface AuditResult {
  findings: Finding[]
  pages: PageSnapshot[]
  summary: Record<string, number | string | null>
}

const MAX_LIST = 50

/**
 * AI crawlers checked against robots.txt and the server. `search` ones decide whether pages can be
 * cited in AI answers; the others collect training data. Tokens and user agents as published by
 * OpenAI, Anthropic and Perplexity (re-check them now and then — they change).
 */
const AI_AGENTS: Array<{ token: string; ua: string; search: boolean }> = [
  { token: "OAI-SearchBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", search: true },
  { token: "ChatGPT-User", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", search: true },
  { token: "Claude-SearchBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)", search: true },
  { token: "Claude-User", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +https://www.anthropic.com)", search: true },
  { token: "PerplexityBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", search: true },
  { token: "Bingbot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/120.0.0.0 Safari/537.36", search: true },
  { token: "GPTBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot", search: false },
  { token: "ClaudeBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", search: false },
  { token: "Google-Extended", ua: "", search: false },
  { token: "CCBot", ua: "CCBot/2.0 (https://commoncrawl.org/faq/)", search: false },
]
const ASSET = /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|xml|txt|json|css|js|mp4|webm|zip|woff2?)$/i

/** Health wording Google's healthcare policy commonly disapproves in Shopping and ads. */
const CLAIMS: Array<[RegExp, string]> = [
  [/\b(cures?|cured|curing)\b/i, "cure claim"],
  [/\b(treatment|treating|treats? (the|your|acne|skin|hair|dandruff|symptoms|pain))\b/i, "treatment claim"],
  [/\bheal(s|ing)?\b/i, "healing claim"],
  [/\bprevent(s|ion)?\b/i, "prevention claim"],
  [/\b(disease|diabet\w*|cancer|infection\w*|eczema|psoriasis|thyroid|pcod|pcos|blood sugar|cholesterol)\b/i, "names a medical condition"],
  [/\b(antibacterial|antifungal|antiviral|antiseptic|anti-?inflammatory)\b/i, "drug-like property"],
  [/\bdetox\w*\b/i, "detox claim"],
  [/\bimmun\w*\b/i, "immunity claim"],
  [/\bweight loss\b/i, "weight-loss claim"],
  [/\bclinically\b/i, "clinical claim"],
]

interface Crawled {
  url: string
  fetched: Fetched
  parsed: ParsedPage | null
  inSitemap: boolean
}

export async function auditSite(site: SiteInput): Promise<AuditResult> {
  const started = Date.now()
  const s = site.settings
  const base = new URL(site.baseUrl)
  const host = base.host.replace(/^www\./, "")
  const maxPages = Math.max(10, Math.min(s.maxPages ?? 400, 2000))
  const thinWords = s.thinWords ?? 250
  const productRe = s.productPath ? new RegExp(s.productPath) : null
  /* Prefix match, with "!"-prefixed entries as exceptions. */
  const startsWithAny = (path: string, list?: string[]) => {
    const l = list ?? []
    if (l.some((p) => p.startsWith("!") && path.startsWith(p.slice(1)))) return false
    return l.some((p) => !p.startsWith("!") && path.startsWith(p))
  }
  /* One spelling per address: "https://x.in" and "https://x.in/" are the same page. */
  const key = (u: string) => u.replace(/\/+$/, "")

  const findings: Finding[] = []
  const add = (f: Omit<Finding, "urls"> & { urls?: string[] }) =>
    findings.push({ ...f, urls: (f.urls ?? []).slice(0, MAX_LIST), evidence: { ...(f.evidence ?? {}), ...(f.urls && f.urls.length > MAX_LIST ? { total: f.urls.length } : {}) } })

  /* Internal, crawlable, normalised: same host, no fragment, no query, not an asset or ignored path. */
  const internal = (href: string, from: string): string | null => {
    let u: URL
    try {
      u = new URL(href, from)
    } catch {
      return null
    }
    if (!/^https?:$/.test(u.protocol) || u.host.replace(/^www\./, "") !== host) return null
    if (ASSET.test(u.pathname) || startsWithAny(u.pathname, s.ignorePaths)) return null
    u.hash = ""
    u.search = ""
    return u.toString()
  }
  const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "")

  /* ── robots.txt ─────────────────────────────────────────────────────────────────────────── */
  const robotsRes = await fetchUrl(new URL("/robots.txt", base).toString())
  const robots = robotsRes.status === 200 ? parseRobots(robotsRes.body) : { sitemaps: [], disallow: [], allow: [] }
  if (robotsRes.status !== 200) {
    add({
      checkId: "robots-unreachable", category: "indexing", severity: "error", fingerprint: "robots-unreachable",
      title: "robots.txt does not load", detail: `It answered ${robotsRes.status || robotsRes.error}.`,
      fix: "Serve /robots.txt with status 200. Without it crawlers guess, and some stop.", urls: [robotsRes.url],
    })
  } else if (!robots.sitemaps.length) {
    add({
      checkId: "robots-no-sitemap", category: "sitemap", severity: "warning", fingerprint: "robots-no-sitemap",
      title: "robots.txt does not point to the sitemap", detail: "No `Sitemap:` line.",
      fix: `Add "Sitemap: ${site.sitemapUrl}" to robots.txt so every crawler finds it, not just Google.`, urls: [robotsRes.url],
    })
  }

  /* ── sitemap (index files followed one level) ───────────────────────────────────────────── */
  const sitemapEntries: Array<{ loc: string; lastmod: string | null }> = []
  const smRes = await fetchUrl(site.sitemapUrl)
  if (smRes.status !== 200) {
    add({
      checkId: "sitemap-unreachable", category: "sitemap", severity: "error", fingerprint: "sitemap-unreachable",
      title: "The sitemap does not load", detail: `It answered ${smRes.status || smRes.error}.`,
      fix: "Serve the sitemap with status 200. Until then Google only finds pages by following links.", urls: [site.sitemapUrl],
    })
  } else {
    const first = parseSitemap(smRes.body)
    sitemapEntries.push(...first.urls)
    for (const child of first.children.slice(0, 20)) {
      const c = await fetchUrl(child)
      if (c.status === 200) sitemapEntries.push(...parseSitemap(c.body).urls)
      else add({
        checkId: "sitemap-child-unreachable", category: "sitemap", severity: "error", fingerprint: `sitemap-child-unreachable:${child}`,
        title: "A sitemap file listed in the sitemap index does not load", detail: `Answered ${c.status || c.error}.`,
        fix: "Fix or remove that sitemap file from the index.", urls: [child],
      })
    }
    if (!sitemapEntries.length) add({
      checkId: "sitemap-empty", category: "sitemap", severity: "error", fingerprint: "sitemap-empty",
      title: "The sitemap lists no pages", detail: "It loaded but has no <url> entries.",
      fix: "Check the sitemap generator — it may be failing to reach the catalogue or CMS.", urls: [site.sitemapUrl],
    })
  }

  const seen = new Set<string>()
  const dups: string[] = []
  const sitemapUrls: string[] = []
  for (const e of sitemapEntries) {
    if (seen.has(key(e.loc))) dups.push(e.loc)
    else {
      seen.add(key(e.loc))
      sitemapUrls.push(e.loc)
    }
  }
  if (dups.length) add({
    checkId: "sitemap-duplicates", category: "sitemap", severity: "warning", fingerprint: "sitemap-duplicates",
    title: `${dups.length} address(es) listed twice in the sitemap`, detail: "Each page should appear once.",
    fix: "Remove the duplicate entries in the sitemap generator.", urls: dups,
  })

  const foreign = sitemapUrls.filter((u) => {
    try { return new URL(u).host.replace(/^www\./, "") !== host } catch { return true }
  })
  if (foreign.length) add({
    checkId: "sitemap-foreign", category: "sitemap", severity: "error", fingerprint: "sitemap-foreign",
    title: "The sitemap lists addresses on another domain", detail: "A sitemap may only list its own site's pages.",
    fix: "Use the site's own domain (check NEXT_PUBLIC_SITE_URL or the equivalent setting).", urls: foreign,
  })

  const blocked = sitemapUrls.filter((u) => { try { return robotsBlocks(robots, new URL(u).pathname) } catch { return false } })
  if (blocked.length) add({
    checkId: "sitemap-blocked", category: "indexing", severity: "error", fingerprint: "sitemap-blocked",
    title: "The sitemap lists pages that robots.txt blocks", detail: "Google is told to crawl them and forbidden to, at once.",
    fix: "Either remove them from the sitemap or stop blocking them in robots.txt.", urls: blocked,
  })

  const privateListed = sitemapUrls.filter((u) => { try { return startsWithAny(new URL(u).pathname, s.privatePaths) } catch { return false } })
  if (privateListed.length) add({
    checkId: "sitemap-private", category: "sitemap", severity: "error", fingerprint: "sitemap-private",
    title: "The sitemap lists private pages", detail: "Account, cart, checkout or app screens are not meant for search.",
    fix: "Leave these paths out of the sitemap.", urls: privateListed,
  })

  const lastmods = sitemapEntries.map((e) => (e.lastmod ? Date.parse(e.lastmod) : NaN)).filter(Number.isFinite)
  const recent = lastmods.filter((t) => Math.abs(started - t) < 3 * 3600_000).length
  if (sitemapEntries.length >= 10 && recent / sitemapEntries.length > 0.5) add({
    checkId: "sitemap-lastmod-now", category: "sitemap", severity: "warning", fingerprint: "sitemap-lastmod-now",
    title: "Most sitemap dates say \"just now\"", detail: `${recent} of ${sitemapEntries.length} entries are dated within the last 3 hours.`,
    fix: "Use the date the content actually changed, or leave lastmod out. A date that is always \"now\" teaches Google to ignore it.",
    urls: [site.sitemapUrl],
  })

  /* ── crawl: every sitemap page, then pages they link to that the sitemap does not list ─── */
  const crawled = new Map<string, Crawled>()
  const crawl = async (url: string, inSitemap: boolean) => {
    const fetched = await fetchUrl(url)
    const isHtml = (fetched.headers["content-type"] ?? "").includes("html")
    crawled.set(url, { url, fetched, parsed: fetched.status === 200 && isHtml ? parsePage(fetched.body) : null, inSitemap })
  }
  const listed = sitemapUrls.filter((u) => !foreign.includes(u))
  const first = (seen.has(key(base.toString())) ? listed : [base.toString(), ...listed]).slice(0, maxPages)
  await pool(first, 4, (u) => crawl(u, seen.has(key(u))))

  /* Who links to whom, from every crawled page. */
  const inlinks = new Map<string, Set<string>>()
  const linkFrom = (c: Crawled) => {
    for (const href of c.parsed?.links ?? []) {
      const t = internal(href, c.url)
      if (!t || sameUrl(t, c.url)) continue
      if (!inlinks.has(t)) inlinks.set(t, new Set())
      inlinks.get(t)!.add(c.url)
    }
  }
  for (const c of crawled.values()) linkFrom(c)

  const crawledHas = (t: string) => Array.from(crawled.keys()).some((k) => sameUrl(k, t))
  const extra = Array.from(inlinks.keys())
    .filter((t) => !crawledHas(t) && !startsWithAny(new URL(t).pathname, s.privatePaths) && !robotsBlocks(robots, new URL(t).pathname))
    .slice(0, Math.max(0, maxPages - crawled.size))
  await pool(extra, 4, (u) => crawl(u, false))
  for (const u of extra) linkFrom(crawled.get(u)!)

  const inlinkCount = (u: string) => {
    let n = 0
    for (const [t, from] of inlinks) if (sameUrl(t, u)) n += Array.from(from).filter((f) => !sameUrl(f, u)).length
    return n
  }

  /* ── soft 404 ─────────────────────────────────────────────────────────────────────────── */
  const probe = await fetchUrl(new URL(`/this-page-does-not-exist-${started.toString(36)}`, base).toString())
  if (probe.status === 200) add({
    checkId: "soft-404", category: "indexing", severity: "error", fingerprint: "soft-404",
    title: "Missing pages answer 200 instead of 404", detail: "A made-up address returned a normal page.",
    fix: "Return a real 404 status for unknown addresses, or Google indexes empty and duplicate pages.", urls: [probe.url],
  })

  /* ── per page ─────────────────────────────────────────────────────────────────────────── */
  const sitemapPages = Array.from(crawled.values()).filter((c) => c.inSitemap)
  const group = new Map<string, { f: Omit<Finding, "urls">; urls: string[] }>()
  const bucket = (f: Omit<Finding, "urls">, url: string) => {
    const g = group.get(f.fingerprint) ?? { f, urls: [] }
    g.urls.push(url)
    group.set(f.fingerprint, g)
  }

  const titles = new Map<string, string[]>()
  const descs = new Map<string, string[]>()
  const productSkus = new Map<string, { url: string; offers: Array<Record<string, any>> }>()
  const productImages = new Map<string, string[]>()

  for (const c of sitemapPages) {
    const { fetched: f, parsed: p, url } = c
    const path = new URL(url).pathname

    if (f.status >= 300 && f.status < 400) {
      bucket({ checkId: "page-redirect", category: "sitemap", severity: "error", fingerprint: "page-redirect",
        title: "The sitemap lists addresses that redirect", detail: "List the final address, not the one that forwards.",
        fix: "Replace each with the address it redirects to (or drop it if that one is already listed)." }, `${url} → ${f.location}`)
      continue
    }
    if (f.status !== 200) {
      bucket({ checkId: "page-error", category: "indexing", severity: "error", fingerprint: `page-error:${f.status}`,
        title: f.status === 0 ? "Pages in the sitemap did not respond" : `Pages in the sitemap answer ${f.status}`,
        detail: f.status === 404 ? "They are gone, but the sitemap still lists them." : "Google cannot index a page that does not load.",
        fix: f.status === 404 ? "Remove them from the sitemap, or redirect them to the closest live page." : "Check the server logs for these addresses." }, url)
      continue
    }
    if (!p) continue

    const headerRobots = f.headers["x-robots-tag"] ?? ""
    const robotsText = [headerRobots, p.robotsMeta].filter(Boolean).join(" | ")
    if (/noindex/i.test(robotsText)) {
      bucket({ checkId: "page-noindex", category: "indexing", severity: "error", fingerprint: "page-noindex",
        title: "The sitemap lists pages marked noindex", detail: "The sitemap asks Google to index them; the page (or its header) says not to.",
        fix: "Decide which is right: drop them from the sitemap, or remove the noindex (check the X-Robots-Tag header too)." }, url)
      continue
    }

    if (!p.canonical) {
      bucket({ checkId: "canonical-missing", category: "indexing", severity: "warning", fingerprint: "canonical-missing",
        title: "Pages with no canonical address", detail: "Without one, Google picks which version of the address counts.",
        fix: "Give each page a self-referencing canonical." }, url)
    } else {
      const canon = new URL(p.canonical, url).toString()
      if (!sameUrl(canon, url)) bucket({ checkId: "canonical-elsewhere", category: "indexing", severity: "error", fingerprint: "canonical-elsewhere",
        title: "The sitemap lists pages whose canonical points elsewhere", detail: "These pages say another address is the original, so Google indexes that one instead.",
        fix: "List only the canonical address in the sitemap, or fix the canonical if it is wrong." }, `${url} → ${canon}`)
    }

    if (!p.title) bucket({ checkId: "title-missing", category: "metadata", severity: "error", fingerprint: "title-missing",
      title: "Pages with no title", detail: "The title is the link text in search results.", fix: "Give each page a unique, descriptive title." }, url)
    else {
      titles.set(p.title, [...(titles.get(p.title) ?? []), url])
      if (p.title.length > 70) bucket({ checkId: "title-long", category: "metadata", severity: "info", fingerprint: "title-long",
        title: "Titles longer than about 70 characters", detail: "Google cuts them off in results.", fix: "Put the important words first, or shorten." }, url)
    }
    if (!p.description) bucket({ checkId: "description-missing", category: "metadata", severity: "warning", fingerprint: "description-missing",
      title: "Pages with no meta description", detail: "Google writes its own snippet, often a poor one.", fix: "Add a one- or two-sentence description of the page." }, url)
    else {
      descs.set(p.description, [...(descs.get(p.description) ?? []), url])
      if (p.description.length > 170 || p.description.length < 50) bucket({ checkId: "description-length", category: "metadata", severity: "info", fingerprint: "description-length",
        title: "Descriptions much shorter than 50 or longer than 170 characters", detail: "Long ones are cut off; very short ones say little.", fix: "Aim for 120–160 characters." }, url)
    }
    if (p.h1Count !== 1) bucket({ checkId: "h1", category: "metadata", severity: "warning", fingerprint: `h1:${p.h1Count === 0 ? "none" : "many"}`,
      title: p.h1Count === 0 ? "Pages with no main heading (H1) in the HTML" : "Pages with more than one main heading (H1)",
      detail: p.h1Count === 0 ? "Often a heading that only appears after JavaScript runs." : "One H1 per page states what the page is about.",
      fix: p.h1Count === 0 ? "Render the page's heading on the server as an <h1>." : "Keep one <h1>; make the others <h2>." }, url)
    if (p.words < thinWords) bucket({ checkId: "thin", category: "content", severity: "info", fingerprint: "thin",
      title: `Pages with fewer than ${thinWords} words`, detail: "Thin pages are often left unindexed.", fix: "Add useful text, or keep the page out of the sitemap." }, url)
    if (f.ms > 3000) bucket({ checkId: "slow", category: "speed", severity: "warning", fingerprint: "slow",
      title: "Pages that took over 3 seconds to answer", detail: "Measured from the monitor; slow pages are crawled less.", fix: "Check caching and slow database calls on these routes." }, `${url} (${(f.ms / 1000).toFixed(1)} s)`)
    if (p.imagesWithoutAlt > 0) bucket({ checkId: "img-alt", category: "images", severity: "warning", fingerprint: "img-alt",
      title: "Images with no alt text", detail: "Alt text is how search engines and screen readers understand an image.", fix: "Add a short description as alt; use alt=\"\" for purely decorative images." }, `${url} (${p.imagesWithoutAlt})`)
    if (p.jsonldInvalid > 0) bucket({ checkId: "jsonld-invalid", category: "structured-data", severity: "error", fingerprint: "jsonld-invalid",
      title: "Structured data that does not parse", detail: "Google ignores the whole block.", fix: "Fix the JSON in the ld+json script on these pages." }, url)

    /* Product structured data — every Product node, wherever it appears (lists included). */
    const products = p.jsonld.filter((n) => typesOf(n).includes("Product"))
    const isProductPage = productRe ? productRe.test(path) : false
    if (isProductPage && !products.length) bucket({ checkId: "product-schema-missing", category: "structured-data", severity: "warning", fingerprint: "product-schema-missing",
      title: "Product pages with no Product structured data", detail: "They cannot appear in product results. Often a product with no photo (deliberately left out).",
      fix: "Make sure the product has a real photo, description and price — the schema follows from those." }, url)
    for (const prod of products) {
      const offers = (Array.isArray(prod.offers) ? prod.offers : prod.offers ? [prod.offers] : []) as Array<Record<string, any>>
      const missing: Array<[string, Severity]> = []
      if (!prod.name) missing.push(["name", "error"])
      if (!prod.image) missing.push(["image", "error"])
      if (!offers.length) missing.push(["offers", "error"])
      for (const o of offers) {
        if (o.price == null) missing.push(["offers.price", "error"])
        if (!o.priceCurrency) missing.push(["offers.priceCurrency", "error"])
        if (!o.availability) missing.push(["offers.availability", "error"])
        if (!o.shippingDetails) missing.push(["offers.shippingDetails", "warning"])
        if (!o.hasMerchantReturnPolicy) missing.push(["offers.hasMerchantReturnPolicy", "warning"])
      }
      if (!prod.sku && !offers.some((o) => o.sku)) missing.push(["sku", "warning"])
      if (!prod.brand) missing.push(["brand", "warning"])
      if (!prod.description) missing.push(["description", "warning"])
      for (const [field, sev] of Array.from(new Map(missing))) bucket({
        checkId: "product-field", category: "structured-data", severity: sev, fingerprint: `product-field:${field}`,
        title: `Product structured data missing "${field}"`,
        detail: isProductPage ? "Google needs it for product results and merchant listings." : "On a listing page — usually better to name products by URL only and keep the full Product on its own page.",
        fix: isProductPage ? `Fill in ${field} on the product (or in the schema generator).` : "Make list items URL-only (ListItem with url), or give each the full set of fields.",
      }, url)
      const imgs = (Array.isArray(prod.image) ? prod.image : prod.image ? [prod.image] : []).map((i: any) => (typeof i === "string" ? i : i?.url)).filter(Boolean)
      if (isProductPage) productImages.set(url, imgs)
      if (isProductPage) for (const o of offers) {
        const sku = String(o.sku ?? prod.sku ?? "")
        if (sku) productSkus.set(sku, { url, offers: [o] })
      }
    }

    if (s.claimCheck && isProductPage) {
      const text = [p.description, ...products.map((n) => n.description)].filter(Boolean).join(" ")
      for (const [re, label] of CLAIMS) {
        const m = text.match(re)
        if (m) bucket({ checkId: "health-claim", category: "content", severity: "warning", fingerprint: `health-claim:${label}`,
          title: `Health wording Google may disapprove: ${label}`, detail: "Google's healthcare policy limits disease, treatment and drug-like claims in Shopping and ads.",
          fix: "Reword as traditional or cosmetic use, e.g. \"used in Ayurvedic skin rituals\", rather than a health benefit." }, `${url} ("${m[0]}")`)
      }
    }
  }

  for (const [t, urls] of titles) if (urls.length > 1) add({
    checkId: "title-duplicate", category: "metadata", severity: "warning", fingerprint: `title-duplicate:${t}`,
    title: `${urls.length} pages share the title "${t.slice(0, 80)}"`, detail: "Google treats pages with the same title as likely duplicates.",
    fix: "Give each page its own title — or, if they really are the same page, point the canonical of the copies to the original.", urls,
  })
  for (const [d, urls] of descs) if (urls.length > 1) add({
    checkId: "description-duplicate", category: "metadata", severity: "warning", fingerprint: `description-duplicate:${d.slice(0, 120)}`,
    title: `${urls.length} pages share one meta description`, detail: `"${d.slice(0, 120)}${d.length > 120 ? "…" : ""}"`,
    fix: "Write a description specific to each page.", urls,
  })

  /* Homepage identity. */
  const home = Array.from(crawled.values()).find((c) => sameUrl(c.url, base.toString()))?.parsed
  if (home) {
    const types = home.jsonld.flatMap(typesOf)
    if (!types.includes("Organization") && !types.some((t) => /LocalBusiness|Store|Corporation/.test(t))) add({
      checkId: "home-organization", category: "structured-data", severity: "warning", fingerprint: "home-organization",
      title: "Homepage has no Organization structured data", detail: "It tells Google who runs the site: name, logo, contact, address.",
      fix: "Add Organization JSON-LD to the homepage.", urls: [base.toString()],
    })
    if (!types.includes("WebSite")) add({
      checkId: "home-website", category: "structured-data", severity: "info", fingerprint: "home-website",
      title: "Homepage has no WebSite structured data", detail: "It names the site and can enable a search box in results.",
      fix: "Add WebSite JSON-LD to the homepage.", urls: [base.toString()],
    })
  }

  /* ── AI search access ─────────────────────────────────────────────────────────────────────
   *
   * Whether AI search and answer engines can read the site at all. Two separate failures:
   * robots.txt refusing a crawler by name, and the server (or a CDN/firewall in front of it)
   * answering that crawler differently from a browser — a 403, or a challenge page that is a fraction
   * of the real page's size. Training crawlers are reported as information only: blocking them is a
   * legitimate choice, blocking search crawlers costs citations. */
  if (robotsRes.status === 200) {
    const samples = [
      base.toString(),
      ...Array.from(crawled.values())
        .filter((c) => c.fetched.status === 200 && productRe?.test(new URL(c.url).pathname))
        .slice(0, 1)
        .map((c) => c.url),
    ]
    const blockedSearch: string[] = []
    const blockedTraining: string[] = []
    for (const a of AI_AGENTS) {
      const rules = parseRobots(robotsRes.body, a.token)
      const blocked = samples.filter((u) => robotsBlocks(rules, new URL(u).pathname))
      if (blocked.length) (a.search ? blockedSearch : blockedTraining).push(`${a.token}: ${blocked.join(", ")}`)
      /* Private paths must stay closed to named crawlers too. */
      /* Only paths "*" does block count: those are the ones the site meant to keep out. */
      const open = (s.privatePaths ?? []).filter((p) => !p.startsWith("!") && robotsBlocks(robots, p) && !robotsBlocks(rules, p))
      if (open.length) {
        add({
          checkId: "ai-private-open", category: "ai", severity: "warning", fingerprint: `ai-private-open:${a.token}`,
          title: `robots.txt lets ${a.token} into private paths`,
          detail: `A group naming ${a.token} replaces the "*" group for it, and this one does not repeat the private paths.`,
          fix: `Repeat the Disallow lines for ${open.join(", ")} in the ${a.token} group.`, urls: open,
        })
      }
    }
    if (blockedSearch.length) add({
      checkId: "ai-search-blocked", category: "ai", severity: "error", fingerprint: "ai-search-blocked",
      title: "robots.txt blocks AI search crawlers", detail: "Pages they cannot read cannot be cited in ChatGPT, Claude or Perplexity answers.",
      fix: "Allow these crawlers in robots.txt (training crawlers can be blocked separately).", urls: blockedSearch,
    })
    if (blockedTraining.length) add({
      checkId: "ai-training-blocked", category: "ai", severity: "info", fingerprint: "ai-training-blocked",
      title: "robots.txt blocks AI training crawlers", detail: "A legitimate choice; it does not affect AI search citations.",
      fix: "Nothing to fix if this is intended.", urls: blockedTraining,
    })

    const normal = new Map(samples.map((u) => [u, crawled.get(u)?.fetched.body.length ?? 0]))
    const denied: string[] = []
    const different: string[] = []
    for (const a of AI_AGENTS.filter((x) => x.search)) {
      for (const u of samples) {
        const r = await fetchUrl(u, { userAgent: a.ua, timeoutMs: 15_000 })
        if (r.status !== 200) denied.push(`${a.token} → ${u} (${r.status || r.error || "no answer"})`)
        else if ((normal.get(u) ?? 0) > 5000 && r.body.length < (normal.get(u) ?? 0) * 0.3)
          different.push(`${a.token} → ${u} (${r.body.length} vs ${normal.get(u)} bytes)`)
      }
    }
    if (denied.length) add({
      checkId: "ai-denied", category: "ai", severity: "error", fingerprint: "ai-denied",
      title: "AI crawlers are refused by the server", detail: "robots.txt allows them, but the server, CDN or firewall answers with an error.",
      fix: "Check bot-protection or firewall rules for these user agents.", urls: denied,
    })
    if (different.length) add({
      checkId: "ai-different", category: "ai", severity: "warning", fingerprint: "ai-different",
      title: "AI crawlers get a much smaller page than browsers", detail: "Usually a bot challenge or an error page served with status 200.",
      fix: "Check bot-protection settings; crawlers should get the same HTML as everyone else.", urls: different,
    })
  }

  /* Listing pages that should always show products — an empty one cached as 200 tells every crawler
     the shop sells nothing. Configured per site (Settings → listing pages). */
  if (productRe) {
    const empty: string[] = []
    for (const lp of s.listingPaths ?? []) {
      const u = new URL(lp, base).toString()
      const c = Array.from(crawled.values()).find((x) => sameUrl(x.url, u))
      const f = c?.fetched ?? (await fetchUrl(u))
      const parsed = c?.parsed ?? (f.status === 200 ? parsePage(f.body) : null)
      if (f.status !== 200) continue // reported as page-error / broken-link elsewhere
      const productLinks = (parsed?.links ?? []).filter((h) => {
        const t = internal(h, u)
        return t ? productRe.test(new URL(t).pathname) : false
      })
      if (!productLinks.length) empty.push(u)
    }
    if (empty.length) add({
      checkId: "listing-empty", category: "ai", severity: "error", fingerprint: "listing-empty",
      title: "Listing pages showing no products", detail: "The page loads but links to no product — crawlers read it as an empty shop.",
      fix: "Check the catalogue connection; the page should keep its last good version when the catalogue is down.", urls: empty,
    })
  }

  /* llms.txt — optional. If present, every link in it should work. */
  const llms = await fetchUrl(new URL("/llms.txt", base).toString())
  if (llms.status === 200) {
    const links = Array.from(llms.body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)).map((m) => m[1])
    const broken: string[] = []
    await pool(links.slice(0, 300), 4, async (l) => {
      const c = Array.from(crawled.values()).find((x) => sameUrl(x.url, l))
      const st = c ? c.fetched.status : (await fetchUrl(l, { method: "HEAD" })).status
      if (st !== 200) broken.push(`${l} (${st})`)
    })
    if (!/text\/plain|text\/markdown/i.test(llms.headers["content-type"] ?? "")) add({
      checkId: "llms-type", category: "ai", severity: "info", fingerprint: "llms-type",
      title: "llms.txt is not served as plain text", detail: `Content-Type is "${llms.headers["content-type"] ?? "none"}".`,
      fix: "Serve it as text/plain.", urls: [llms.url],
    })
    if (broken.length) add({
      checkId: "llms-broken-link", category: "ai", severity: "warning", fingerprint: "llms-broken-link",
      title: "llms.txt links that do not work", detail: "AI tools reading the file are sent to dead pages.",
      fix: "Generate llms.txt from the published pages so it cannot drift.", urls: broken,
    })
  } else {
    add({
      checkId: "llms-missing", category: "ai", severity: "info", fingerprint: "llms-missing",
      title: "No llms.txt", detail: "Optional. A plain-text map of the site for AI tools; nothing guarantees they use it.",
      fix: "Nothing required.", urls: [new URL("/llms.txt", base).toString()],
    })
  }

  /* ── links ────────────────────────────────────────────────────────────────────────────── */
  for (const c of crawled.values()) {
    if (c.inSitemap) continue
    const from = Array.from(inlinks.entries()).filter(([t]) => sameUrl(t, c.url)).flatMap(([, f]) => Array.from(f))
    const st = c.fetched.status
    if (st === 0 || st >= 400) add({
      checkId: "broken-link", category: "links", severity: "error", fingerprint: `broken-link:${c.url}`,
      title: `${from.length} page(s) link to ${new URL(c.url).pathname}, which answers ${st || "nothing"}`,
      detail: "Visitors and crawlers hit a dead end. Common after a product is hidden or a page is renamed.",
      fix: "Remove or change the links on the pages listed, or redirect the old address to the closest live page.",
      urls: from, evidence: { target: c.url, status: st },
    })
    else if (st >= 300 && st < 400) add({
      checkId: "link-redirect", category: "links", severity: "info", fingerprint: `link-redirect:${c.url}`,
      title: `Links to ${new URL(c.url).pathname}, which redirects`, detail: `It forwards to ${c.fetched.location}.`,
      fix: "Link straight to the final address.", urls: from, evidence: { target: c.url, to: c.fetched.location },
    })
    else if (st === 200 && c.parsed) {
      const robotsText = [c.fetched.headers["x-robots-tag"], c.parsed.robotsMeta].filter(Boolean).join(" ")
      const canon = c.parsed.canonical ? new URL(c.parsed.canonical, c.url).toString() : c.url
      if (!/noindex/i.test(robotsText) && sameUrl(canon, c.url) && !seen.has(key(canon))) bucket({
        checkId: "missing-from-sitemap", category: "sitemap", severity: "warning", fingerprint: "missing-from-sitemap",
        title: "Indexable pages that are linked but missing from the sitemap", detail: "Google finds them only by following links, and slowly.",
        fix: "Add them to the sitemap generator — or, if they should not be in search, give them noindex.",
      }, c.url)
    }
  }
  for (const c of sitemapPages) {
    if (c.fetched.status !== 200 || sameUrl(c.url, base.toString())) continue
    const n = inlinkCount(c.url)
    if (n === 0) bucket({ checkId: "orphan", category: "links", severity: "warning", fingerprint: "orphan",
      title: "Sitemap pages that no other page links to", detail: "Google often leaves these as \"discovered, not indexed\".",
      fix: "Link to them from a related collection, category or article." }, c.url)
    else if (n <= 2) bucket({ checkId: "few-links", category: "links", severity: "info", fingerprint: "few-links",
      title: "Sitemap pages with only 1–2 internal links", detail: "Weakly linked pages are crawled and ranked less.",
      fix: "Add links from related pages (e.g. \"more like this\" sections)." }, `${c.url} (${n})`)
  }

  /* ── product images ───────────────────────────────────────────────────────────────────── */
  const allImages = Array.from(new Set(Array.from(productImages.values()).flat()))
  const imageOk = new Map<string, boolean>()
  await pool(allImages, 6, async (u) => imageOk.set(u, (await imageLoads(u)).ok))
  for (const [page, imgs] of productImages) for (const img of imgs) if (!imageOk.get(img)) bucket({
    checkId: "product-image-broken", category: "images", severity: "error", fingerprint: "product-image-broken",
    title: "Product images that do not load", detail: "Google rejects a product whose image fails.",
    fix: "Re-upload the image or remove the broken link from the product.",
  }, `${page} → ${img}`)

  /* ── Merchant feed ────────────────────────────────────────────────────────────────────── */
  let feedItems = 0
  if (site.feedUrl) {
    const fr = await fetchUrl(site.feedUrl, { timeoutMs: 60_000 })
    if (fr.status !== 200) add({
      checkId: "feed-unreachable", category: "feed", severity: "error", fingerprint: "feed-unreachable",
      title: "The Merchant feed does not load", detail: `It answered ${fr.status || fr.error}.`,
      fix: "Merchant Center keeps the last copy for a while, then products start expiring. Fix the feed route.", urls: [site.feedUrl],
    })
    else {
      const items = parseFeed(fr.body)
      feedItems = items.length
      if (!items.length) add({
        checkId: "feed-empty", category: "feed", severity: "error", fingerprint: "feed-empty",
        title: "The Merchant feed has no products", detail: "It loaded but lists no items.", fix: "Check the feed builder's catalogue connection.", urls: [site.feedUrl],
      })
      const ids = new Map<string, number>()
      for (const it of items) if (it.id) ids.set(it.id, (ids.get(it.id) ?? 0) + 1)
      const dupIds = Array.from(ids).filter(([, n]) => n > 1).map(([id]) => id)
      if (dupIds.length) add({
        checkId: "feed-duplicate-id", category: "feed", severity: "error", fingerprint: "feed-duplicate-id",
        title: "Feed items share an id", detail: "Merchant Center keeps only one of them.", fix: "Give every variant its own SKU.", urls: dupIds,
      })
      for (const it of items) {
        const who = it.id ?? it.link ?? "(no id)"
        for (const [field, v] of [["id", it.id], ["title", it.title], ["description", it.description], ["link", it.link], ["image_link", it.imageLink], ["price", it.price], ["availability", it.availability]] as const)
          if (!v) bucket({ checkId: "feed-field", category: "feed", severity: "error", fingerprint: `feed-field:${field}`,
            title: `Feed items missing ${field}`, detail: "Merchant Center rejects items without it.", fix: `Fill in ${field} for these products.` }, who)
        if (s.claimCheck) {
          const text = `${it.title ?? ""} ${it.description ?? ""}`
          for (const [re, label] of CLAIMS) {
            const m = text.match(re)
            if (m) bucket({ checkId: "feed-health-claim", category: "feed", severity: "warning", fingerprint: `feed-health-claim:${label}`,
              title: `Feed wording Google may disapprove: ${label}`, detail: "Health and medical claims are a common reason for Shopping disapprovals.",
              fix: "Reword the product description in the catalogue." }, `${who} ("${m[0]}")`)
          }
        }
        if (!it.link) continue
        const page = Array.from(crawled.values()).find((c) => sameUrl(c.url, it.link!))
        const status = page ? page.fetched.status : (await fetchUrl(it.link)).status
        if (status !== 200) {
          bucket({ checkId: "feed-link-broken", category: "feed", severity: "error", fingerprint: "feed-link-broken",
            title: "Feed items whose product page does not load", detail: "Google disapproves items that land on an error page.",
            fix: "Fix the product page, or remove the product from the feed (e.g. unpublish it)." }, `${who} → ${it.link} (${status})`)
          continue
        }
        if (it.id) {
          const onPage = productSkus.get(it.id)
          if (!onPage) bucket({ checkId: "feed-no-schema", category: "feed", severity: "warning", fingerprint: "feed-no-schema",
            title: "Feed items whose page has no Product data for that SKU", detail: "Google cross-checks the feed against the page.",
            fix: "Make the page's Product structured data carry the same SKU." }, who)
          else {
            const o = onPage.offers[0]
            const feedPrice = parseFloat(String(it.price ?? "").replace(/[^\d.]/g, ""))
            if (o.price != null && Math.abs(Number(o.price) - feedPrice) > 0.005) bucket({ checkId: "feed-price-mismatch", category: "feed", severity: "error", fingerprint: "feed-price-mismatch",
              title: "Feed price differs from the product page", detail: "A price mismatch is an automatic Merchant Center disapproval.",
              fix: "Both should come from the same catalogue price — find where one is overridden." }, `${who}: feed ${feedPrice}, page ${o.price}`)
            const pageAvail = /InStock/i.test(String(o.availability ?? "")) ? "in_stock" : "out_of_stock"
            if (it.availability && it.availability !== pageAvail) bucket({ checkId: "feed-stock-mismatch", category: "feed", severity: "error", fingerprint: "feed-stock-mismatch",
              title: "Feed stock differs from the product page", detail: "Google disapproves items whose availability does not match the page.",
              fix: "Both should come from the same inventory rule." }, `${who}: feed ${it.availability}, page ${pageAvail}`)
          }
        }
        if (it.imageLink && !imageOk.has(it.imageLink)) imageOk.set(it.imageLink, (await imageLoads(it.imageLink)).ok)
        if (it.imageLink && !imageOk.get(it.imageLink)) bucket({ checkId: "feed-image-broken", category: "feed", severity: "error", fingerprint: "feed-image-broken",
          title: "Feed images that do not load", detail: "Items without a working image are rejected.", fix: "Re-upload the product's main image." }, `${who} → ${it.imageLink}`)
      }
      const feedIds = new Set(items.map((i) => i.id).filter(Boolean))
      const notInFeed = Array.from(productSkus).filter(([sku]) => !feedIds.has(sku)).map(([sku, v]) => `${sku} (${v.url})`)
      if (notInFeed.length) add({
        checkId: "feed-missing-product", category: "feed", severity: "warning", fingerprint: "feed-missing-product",
        title: "Products on the site that are not in the feed", detail: "They will not show in Google Shopping.",
        fix: "Usually a missing photo, price or description — the feed's own report says which.", urls: notInFeed,
      })
    }
  }

  for (const { f, urls } of group.values()) add({ ...f, urls })

  const pages: PageSnapshot[] = Array.from(crawled.values()).map((c) => ({
    url: c.url,
    status: c.fetched.status,
    inSitemap: c.inSitemap,
    title: c.parsed?.title ?? null,
    description: c.parsed?.description ?? null,
    canonical: c.parsed?.canonical ?? null,
    robots: [c.fetched.headers["x-robots-tag"], c.parsed?.robotsMeta].filter(Boolean).join(" | ") || null,
    h1Count: c.parsed?.h1Count ?? null,
    words: c.parsed?.words ?? null,
    schemaTypes: Array.from(new Set((c.parsed?.jsonld ?? []).flatMap(typesOf))),
    inlinks: inlinkCount(c.url),
    loadMs: c.fetched.ms,
  }))

  return {
    findings,
    pages,
    summary: {
      sitemapUrls: sitemapUrls.length,
      crawled: crawled.size,
      linkedOnly: extra.length,
      productPages: productSkus.size,
      feedItems: site.feedUrl ? feedItems : null,
      durationMs: Date.now() - started,
    },
  }
}
