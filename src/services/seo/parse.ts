/**
 * Reading what a crawler reads from a page's HTML: head tags, headings, words, links, images and
 * JSON-LD. Deliberately tolerant — a page we cannot fully parse still yields what it can.
 */

export interface ParsedPage {
  title: string | null
  description: string | null
  canonical: string | null
  robotsMeta: string | null
  h1Count: number
  words: number
  /** Every <a href>, as written. */
  links: string[]
  /** <img> tags with no alt attribute at all (alt="" is a deliberate decorative image). */
  imagesWithoutAlt: number
  images: number
  /** Every JSON-LD node, flattened (arrays and @graph unwrapped, nested items included). */
  jsonld: Array<Record<string, any>>
  /** JSON-LD blocks that did not parse. */
  jsonldInvalid: number
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " }
export const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16))
    if (k.startsWith("#") && k !== "#39") return String.fromCodePoint(parseInt(k.slice(1), 10))
    return ENTITIES[k] ?? m
  })

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m: RegExpExecArray | null
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, "").replace(/\/?>$/, "")
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "")
  return out
}

const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? []

/** Every node in a JSON-LD value, including nested objects that carry an @type. */
function flatten(value: unknown, out: Array<Record<string, any>>) {
  if (Array.isArray(value)) {
    for (const v of value) flatten(v, out)
    return
  }
  if (!value || typeof value !== "object") return
  const obj = value as Record<string, any>
  if (obj["@type"]) out.push(obj)
  for (const [k, v] of Object.entries(obj)) {
    if (k === "@context") continue
    if (v && typeof v === "object") flatten(v, out)
  }
}

export function parsePage(html: string): ParsedPage {
  const head = html.slice(0, html.search(/<\/head>/i) > 0 ? html.search(/<\/head>/i) : html.length)

  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  let description: string | null = null
  let robotsMeta: string | null = null
  for (const t of tags(head, "meta")) {
    const a = attrs(t)
    const name = (a.name ?? "").toLowerCase()
    if (name === "description") description = a.content ?? ""
    if (name === "robots" || name === "googlebot") robotsMeta = [robotsMeta, a.content].filter(Boolean).join(", ")
  }
  let canonical: string | null = null
  for (const t of tags(head, "link")) {
    const a = attrs(t)
    if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical")) canonical = a.href ?? null
  }

  const jsonld: Array<Record<string, any>> = []
  let jsonldInvalid = 0
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      flatten(JSON.parse(m[1].trim()), jsonld)
    } catch {
      jsonldInvalid += 1
    }
  }

  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
  const words = decode(bodyText).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

  const links = tags(html, "a").map((t) => attrs(t).href).filter((h): h is string => Boolean(h))
  const imgs = tags(html, "img").map(attrs)

  return {
    title: titleMatch ? decode(titleMatch[1]).replace(/\s+/g, " ").trim() : null,
    description: description !== null ? description.trim() : null,
    canonical,
    robotsMeta,
    h1Count: (html.match(/<h1[\s>]/gi) ?? []).length,
    words,
    links,
    imagesWithoutAlt: imgs.filter((a) => !("alt" in a)).length,
    images: imgs.length,
    jsonld,
    jsonldInvalid,
  }
}

/** The JSON-LD @type(s) of a node, as a list. */
export const typesOf = (node: Record<string, any>): string[] =>
  (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]).map(String)

/* ── sitemaps, robots.txt and the Merchant feed ─────────────────────────────────────────────── */

export function parseSitemap(xml: string): { urls: Array<{ loc: string; lastmod: string | null }>; children: string[] } {
  const isIndex = /<sitemapindex/i.test(xml)
  const blocks = xml.match(isIndex ? /<sitemap>[\s\S]*?<\/sitemap>/gi : /<url>[\s\S]*?<\/url>/gi) ?? []
  const read = (b: string, tag: string) => {
    const m = b.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, "i"))
    return m ? decode(m[1].trim()) : null
  }
  if (isIndex) return { urls: [], children: blocks.map((b) => read(b, "loc")).filter((x): x is string => Boolean(x)) }
  return {
    urls: blocks.map((b) => ({ loc: read(b, "loc") ?? "", lastmod: read(b, "lastmod") })).filter((u) => u.loc),
    children: [],
  }
}

export interface Robots {
  sitemaps: string[]
  /** Disallow rules that apply to every crawler (User-agent: *), as regexes. */
  disallow: RegExp[]
  allow: RegExp[]
}

export function parseRobots(text: string): Robots {
  const sitemaps: string[] = []
  const disallow: RegExp[] = []
  const allow: RegExp[] = []
  let agents: string[] = []
  let inRules = false
  const toRe = (p: string) =>
    new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"))
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === "sitemap") sitemaps.push(val)
    else if (key === "user-agent") {
      if (inRules) agents = []
      inRules = false
      agents.push(val.toLowerCase())
    } else if (key === "disallow" || key === "allow") {
      inRules = true
      if (!agents.includes("*") || !val) continue
      ;(key === "disallow" ? disallow : allow).push(toRe(val))
    }
  }
  return { sitemaps, disallow, allow }
}

/** Is this path blocked for every crawler? Longest match wins, Allow beats Disallow on a tie. */
export function robotsBlocks(robots: Robots, path: string): boolean {
  const len = (re: RegExp) => re.source.length
  const d = robots.disallow.filter((re) => re.test(path)).map(len)
  if (!d.length) return false
  const a = robots.allow.filter((re) => re.test(path)).map(len)
  return Math.max(...d) > (a.length ? Math.max(...a) : -1)
}

export interface FeedItem {
  id: string | null
  title: string | null
  description: string | null
  link: string | null
  imageLink: string | null
  price: string | null
  availability: string | null
}

export function parseFeed(xml: string): FeedItem[] {
  return (xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []).map((b) => {
    const g = (tag: string) => {
      const m = b.match(new RegExp(`<(?:g:)?${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</(?:g:)?${tag}>`, "i"))
      return m ? decode(m[1].trim()) : null
    }
    return {
      id: g("id"),
      title: g("title"),
      description: g("description"),
      link: g("link"),
      imageLink: g("image_link"),
      price: g("price"),
      availability: g("availability"),
    }
  })
}
