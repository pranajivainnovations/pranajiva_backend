/**
 * Fetching pages the way a crawler sees them: one request each, redirects NOT followed (a sitemap
 * that lists a redirect is itself a finding), a hard timeout, and a clear user-agent so the sites'
 * own logs can tell the monitor from a visitor.
 */

export const USER_AGENT = "SEOHealthMonitor/1.0 (+site health check)"

export interface Fetched {
  url: string
  status: number
  /** Where a 3xx pointed, absolute. */
  location: string | null
  headers: Record<string, string>
  body: string
  ms: number
  /** Network failure or timeout, when status is 0. */
  error: string | null
}

export async function fetchUrl(
  url: string,
  opts: { method?: "GET" | "HEAD"; timeoutMs?: number; maxBytes?: number; userAgent?: string } = {}
): Promise<Fetched> {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "manual",
      headers: { "User-Agent": opts.userAgent ?? USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
    const raw = opts.method === "HEAD" ? "" : await res.text()
    const loc = headers["location"]
    return {
      url,
      status: res.status,
      location: loc ? new URL(loc, url).toString() : null,
      headers,
      body: opts.maxBytes ? raw.slice(0, opts.maxBytes) : raw,
      ms: Date.now() - started,
      error: null,
    }
  } catch (e) {
    return {
      url,
      status: 0,
      location: null,
      headers: {},
      body: "",
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** Does an image URL load as an image? HEAD first; some hosts refuse HEAD, so GET on 403/405. */
export async function imageLoads(url: string): Promise<{ ok: boolean; status: number }> {
  let r = await fetchUrl(url, { method: "HEAD", timeoutMs: 15_000 })
  if (r.status === 403 || r.status === 405) r = await fetchUrl(url, { timeoutMs: 15_000, maxBytes: 1 })
  if (r.status >= 300 && r.status < 400 && r.location) r = await fetchUrl(r.location, { method: "HEAD", timeoutMs: 15_000 })
  const type = r.headers["content-type"] ?? ""
  return { ok: r.status === 200 && type.startsWith("image/"), status: r.status }
}

/** Run `fn` over `items` with at most `limit` in flight. Gentle on the sites being checked. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
