import { createHmac, timingSafeEqual } from "crypto"

/**
 * Every call this system makes to Meta, in one file.
 *
 * ── Which API, and why ───────────────────────────────────────────────────────────────────────
 * "Instagram API with Facebook Login" on graph.facebook.com. PranaJiva's app is authorised with a
 * System User access token from Business Manager carrying instagram_basic, instagram_manage_comments,
 * instagram_manage_messages and instagram_content_publish — the Facebook-Login permission set.
 * graph.instagram.com (the Instagram-Login flavour, instagram_business_* scopes) rejects these
 * tokens, so nothing here may call it.
 *
 * What that means in practice:
 *   • DMs go out through the Facebook Page linked to the Instagram account: POST /{page-id}/messages
 *     with that Page's access token (fetched once with the system-user token, stored sealed).
 *   • Webhooks need the Page to have the app installed: POST /{page-id}/subscribed_apps.
 *   • A system-user token does not expire, so there is no refresh — a daily check that it still works.
 *
 * Every call carries appsecret_proof when the app secret is configured, so a leaked token alone is
 * not enough to use it (and apps with "Require App Secret" switched on demand it).
 *
 * The API version is pinned here rather than in .env: moving it is a code change that gets tested.
 */

export const GRAPH_VERSION = "v23.0"
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

export class IgApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly httpStatus: number
  ) {
    super(message)
  }

  /** Throttling or Meta being down: worth trying again later. Everything else is final. */
  get retryable(): boolean {
    return (
      this.httpStatus >= 500 ||
      this.httpStatus === 429 ||
      [1, 2, 4, 17, 32, 341, 613, 80002, 80006].includes(this.code ?? -1)
    )
  }

  /** The token itself is dead — revoked, the system user removed, or the app uninstalled. */
  get tokenInvalid(): boolean {
    return this.code === 190 || this.code === 102
  }

  /** A permission is missing from the token (codes 10, 200–299). */
  get permissionMissing(): boolean {
    return this.code === 10 || (this.code !== null && this.code >= 200 && this.code < 300)
  }
}

function proof(token: string): string | null {
  const secret = process.env.IG_APP_SECRET
  return secret ? createHmac("sha256", secret).update(token).digest("hex") : null
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  url.searchParams.set("access_token", token)
  const p = proof(token)
  if (p) url.searchParams.set("appsecret_proof", p)

  /* AbortController rather than AbortSignal.timeout: this repo's TypeScript predates its typings. */
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    throw new IgApiError(
      `Could not reach Meta (${error instanceof Error ? error.message : "network error"})`,
      null,
      null,
      503
    )
  } finally {
    clearTimeout(timer)
  }

  const json = (await res.json().catch(() => ({}))) as any
  if (!res.ok || json?.error) {
    const e = json?.error ?? {}
    throw new IgApiError(
      String(e.error_user_msg || e.message || `Meta answered ${res.status}`),
      typeof e.code === "number" ? e.code : null,
      typeof e.error_subcode === "number" ? e.error_subcode : null,
      res.status
    )
  }
  return json as T
}

/* ── Identity and setup ────────────────────────────────────────────────────────────────────── */

export interface IgProfile {
  id: string
  username: string
  name?: string
}

/** The Instagram professional account, read with the token — proves the token can reach it. */
export function getIgAccount(igUserId: string, token: string): Promise<IgProfile> {
  return call<IgProfile>("GET", `/${encodeURIComponent(igUserId)}?fields=id,username,name`, token)
}

/**
 * What Meta says about the token: whether it expires and which permissions it carries.
 * Asked with the token itself; best-effort, because some app configurations refuse that.
 */
export async function inspectToken(token: string): Promise<{ expiresAt: Date | null; scopes: string[] } | null> {
  try {
    const res = await call<{ data?: { expires_at?: number; scopes?: string[]; is_valid?: boolean } }>(
      "GET",
      `/debug_token?input_token=${encodeURIComponent(token)}`,
      token
    )
    const d = res.data ?? {}
    return {
      expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null,
      scopes: Array.isArray(d.scopes) ? d.scopes : [],
    }
  } catch {
    return null
  }
}

export interface LinkedPage {
  id: string
  name: string
  access_token: string
}

/**
 * The Facebook Page linked to an Instagram account, with its Page token.
 *
 * A known Page id is read directly; otherwise the Pages this token can manage are searched for the
 * one whose instagram_business_account is ours. Either way needs the Page assigned to the system
 * user in Business Manager and pages_show_list on the token.
 */
export async function findLinkedPage(igUserId: string, token: string, pageId?: string): Promise<LinkedPage | null> {
  if (pageId) {
    const page = await call<LinkedPage & { instagram_business_account?: { id: string } }>(
      "GET",
      `/${encodeURIComponent(pageId)}?fields=id,name,access_token,instagram_business_account`,
      token
    )
    if (page.instagram_business_account?.id && page.instagram_business_account.id !== igUserId) {
      throw new IgApiError(`Page ${page.name} is linked to a different Instagram account.`, null, null, 400)
    }
    return page.access_token ? page : null
  }

  const res = await call<{ data: Array<LinkedPage & { instagram_business_account?: { id: string } }> }>(
    "GET",
    `/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100`,
    token
  )
  return res.data?.find((p) => p.instagram_business_account?.id === igUserId) ?? null
}

/**
 * Installs the app on the Page, which Instagram comment and message webhooks require.
 * subscribed_fields is mandatory and accepts no Instagram fields, so a Page field is named; the
 * Instagram fields themselves are chosen in the App Dashboard.
 */
export function subscribePage(pageId: string, pageToken: string) {
  return call<{ success: boolean }>(
    "POST",
    `/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=feed`,
    pageToken
  )
}

/* ── Content ───────────────────────────────────────────────────────────────────────────────── */

export interface IgMedia {
  id: string
  caption?: string
  media_type?: string
  media_product_type?: string
  permalink?: string
  thumbnail_url?: string
  media_url?: string
  timestamp?: string
}

const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp"

export async function listMedia(igUserId: string, token: string, limit = 30): Promise<IgMedia[]> {
  const res = await call<{ data: IgMedia[] }>(
    "GET",
    `/${encodeURIComponent(igUserId)}/media?fields=${MEDIA_FIELDS}&limit=${limit}`,
    token
  )
  return res.data ?? []
}

export function getMedia(mediaId: string, token: string): Promise<IgMedia> {
  return call<IgMedia>("GET", `/${encodeURIComponent(mediaId)}?fields=${MEDIA_FIELDS}`, token)
}

export interface IgComment {
  id: string
  text?: string
  timestamp?: string
  username?: string
  from?: { id: string; username?: string }
}

/**
 * The top-level comments already on a post, newest first, page by page up to `max`. Used to catch
 * up on comments that arrived before a campaign existed (webhooks only bring new ones).
 */
export async function listComments(mediaId: string, token: string, max = 2000): Promise<IgComment[]> {
  const out: IgComment[] = []
  let after: string | null = null
  while (out.length < max) {
    const page: { data?: IgComment[]; paging?: { cursors?: { after?: string }; next?: string } } = await call(
      "GET",
      `/${encodeURIComponent(mediaId)}/comments?fields=id,text,timestamp,username,from&limit=50${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      token
    )
    out.push(...(page.data ?? []))
    after = page.paging?.next ? page.paging?.cursors?.after ?? null : null
    if (!after || !page.data?.length) break
  }
  return out.slice(0, max)
}

/* ── Responding ────────────────────────────────────────────────────────────────────────────── */

/**
 * A private reply: a DM sent in answer to a comment, through the linked Page.
 * Meta's rules: one per comment, within 7 days of the comment; further messages need the person to
 * write back first (the 24-hour window).
 */
export function sendPrivateReply(pageId: string, pageToken: string, commentId: string, text: string) {
  return call<{ recipient_id?: string; message_id?: string }>("POST", `/${encodeURIComponent(pageId)}/messages`, pageToken, {
    recipient: { comment_id: commentId },
    message: { text },
  })
}

/**
 * A message in an existing conversation, to the person's Instagram-scoped id.
 * Meta's standard messaging window: only within 24 hours of the person's last message to us.
 */
export function sendMessage(pageId: string, pageToken: string, recipientId: string, text: string) {
  return call<{ recipient_id?: string; message_id?: string }>("POST", `/${encodeURIComponent(pageId)}/messages`, pageToken, {
    recipient: { id: recipientId },
    message: { text },
  })
}

/** A public reply under the comment. */
export function replyToComment(commentId: string, token: string, text: string) {
  return call<{ id: string }>("POST", `/${encodeURIComponent(commentId)}/replies`, token, { message: text })
}

/** Hides a comment from everyone but its author (spam, abuse). Reversible from Instagram. */
export function hideComment(commentId: string, token: string, hide = true) {
  return call<{ success: boolean }>("POST", `/${encodeURIComponent(commentId)}?hide=${hide ? "true" : "false"}`, token)
}

/* ── Webhooks ──────────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a webhook really came from Meta: HMAC-SHA256 of the exact bytes keyed with the app secret,
 * sent as `sha256=<hex>`. This check is the authority — a forged delivery would make us message
 * whoever the forger named.
 */
export function verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")
  const given = header.slice("sha256=".length)
  if (given.length !== expected.length || !/^[0-9a-f]+$/i.test(given)) return false
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"))
}

/* ── Reading (analytics, competitors) ──────────────────────────────────────────────────────── */

/**
 * A plain read against the Graph API, for insights, Business Discovery and the access check.
 * GET only: nothing that goes through here can change anything on Instagram.
 */
export function graphGet<T = any>(path: string, token: string): Promise<T> {
  return call<T>("GET", path, token)
}
