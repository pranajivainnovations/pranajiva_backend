import { isMissingSchema, metaDb } from "./db"
import {
  findLinkedPage,
  getIgAccount,
  getMedia,
  hideComment,
  IgApiError,
  inspectToken,
  listMedia,
  replyToComment,
  sendMessage,
  sendPrivateReply,
  subscribePage,
} from "./graph"
import {
  AiUnavailable,
  mergeSettings,
  NEVER_AUTO,
  readComment,
  type AutomationSettings,
  type Category,
  type CommentReading,
} from "./ai"
import { cleanKeywords, cleanTemplates, matchKeyword, type MatchMode } from "./keywords"
import { openToken, sealToken, tokenLast4 } from "./token-box"

/**
 * Meta automation — Instagram campaigns, the comment inbox, DM conversations, one outbound queue.
 * Everything lives in the `meta` schema (services/meta/schema-sql.ts).
 *
 *   Meta ─webhook─▶ recordWebhook()   comments into the inbox (keyword campaigns fire here),
 *                                     DMs into conversations
 *                   triageComment()   AI reading → intent / any-comment campaigns → reply pipeline
 *                   sendQueue()       every DM, public reply, hide and message, with retries
 *   every minute ─▶ drain()           whatever the first attempt did not finish
 *   daily ───────▶ checkAccounts(), rollupAnalytics(), purgeOld()
 *
 * ── Rules enforced here, whatever a campaign, a setting or the model says ────────────────────
 * • One DM, one public reply and one hide per comment (unique in response_queue). Meta allows one
 *   private reply per comment, within 7 days of it.
 * • Conversation messages only inside Meta's 24-hour window after the person last wrote.
 * • A comment triggers at most one campaign: the first by priority, then age.
 * • We never answer our own comments or messages.
 * • "Any comment" campaigns: only on posts an operator selected, only top-level comments, only
 *   after the AI has read them, never on spam, abuse, complaints, health questions, negative or
 *   risky comments, and once per person.
 * • Health questions, complaints, spam and abuse are never answered automatically.
 * • Automatic AI replies are capped per hour; AI readings per day.
 *
 * Every decision is written to meta.execution_logs, so "why did / didn't this person get the DM?"
 * has an answer in OPS.
 */

export class IgError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const MAX_SEND_ATTEMPTS = 5
const MAX_AI_ATTEMPTS = 3
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/* ── Logging ───────────────────────────────────────────────────────────────────────────────── */

async function logExec(
  accountId: string,
  step: string,
  ref: { campaignId?: string | null; commentRowId?: string | null; queueId?: string | null; detail?: string | null } = {}
) {
  await metaDb()
    .query(
      `INSERT INTO meta.execution_logs (account_id, campaign_id, comment_row_id, queue_id, step, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [accountId, ref.campaignId ?? null, ref.commentRowId ?? null, ref.queueId ?? null, step, ref.detail?.slice(0, 1000) ?? null]
    )
    .catch(() => undefined)
}

async function logEvent(accountExternalId: string | null, field: string | null, outcome: string, payload: unknown = null) {
  await metaDb()
    .query(
      `INSERT INTO meta.webhook_events (platform, account_external_id, field, outcome, payload) VALUES ('instagram', $1, $2, $3, $4)`,
      [accountExternalId, field, outcome, payload == null ? null : JSON.stringify(payload)]
    )
    .catch(() => undefined)
}

/* ── Accounts and credentials ──────────────────────────────────────────────────────────────── */

interface AccountRow {
  id: string
  workspace_id: string
  platform: string
  external_id: string
  username: string | null
  linked_account_id: string | null
  status: string
  settings: unknown
}

async function account(id: string): Promise<AccountRow> {
  const { rows } = await metaDb().query(`SELECT * FROM meta.accounts WHERE id = $1`, [id])
  if (!rows[0]) throw new IgError("That account is not connected.", 404)
  return rows[0]
}

async function credential(accountId: string, kind: string): Promise<string | null> {
  const { rows } = await metaDb().query(
    `SELECT sealed FROM meta.credentials WHERE account_id = $1 AND kind = $2 AND revoked_at IS NULL`,
    [accountId, kind]
  )
  return rows[0] ? openToken(rows[0].sealed) : null
}

/** Rotation, not overwrite: the old credential is revoked and kept, the new one becomes active. */
async function setCredential(
  accountId: string,
  kind: string,
  token: string,
  extra: { scopes?: string[]; expiresAt?: Date | null; by?: string | null } = {}
) {
  const db = await metaDb().connect()
  try {
    await db.query("BEGIN")
    await db.query(`UPDATE meta.credentials SET revoked_at = NOW() WHERE account_id = $1 AND kind = $2 AND revoked_at IS NULL`, [
      accountId,
      kind,
    ])
    await db.query(
      `INSERT INTO meta.credentials (account_id, kind, sealed, last4, scopes, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, kind, sealToken(token), tokenLast4(token), extra.scopes ?? [], extra.expiresAt ?? null, extra.by ?? null]
    )
    await db.query("COMMIT")
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    db.release()
  }
}

async function systemToken(a: AccountRow): Promise<string> {
  const t = a.status === "disconnected" ? null : await credential(a.id, "system_user_token")
  if (!t) throw new IgError(`@${a.username} is not connected. Paste the access token in Instagram settings.`)
  return t
}

/** The linked Facebook Page: its id and Page token, which DMs need. */
async function pageOf(a: AccountRow): Promise<{ pageId: string; token: string } | null> {
  if (!a.linked_account_id) return null
  const { rows } = await metaDb().query(`SELECT external_id FROM meta.accounts WHERE id = $1`, [a.linked_account_id])
  const token = rows[0] ? await credential(a.linked_account_id, "page_token") : null
  return rows[0] && token ? { pageId: rows[0].external_id, token } : null
}

/** For acting on comments: the Page token when there is one, else the system-user token. */
async function commentToken(a: AccountRow): Promise<string> {
  return (await pageOf(a))?.token ?? systemToken(a)
}

async function markTokenDead(accountId: string, message: string) {
  await metaDb().query(`UPDATE meta.accounts SET status = 'expired', last_error = $2, updated_at = NOW() WHERE id = $1`, [
    accountId,
    message.slice(0, 500),
  ])
  await logExec(accountId, "token_invalid", { detail: message })
}

export interface ConnectCheck {
  step: string
  ok: boolean
  detail: string
}

/**
 * Connect (or reconnect) an Instagram account from a pasted System User access token, and check
 * everything the module needs, reporting each check so problems show on the spot:
 *   1. the token can read the Instagram account            (required — nothing is stored otherwise)
 *   2. what Meta says about the token: expiry and scopes    (informational)
 *   3. the linked Facebook Page and its Page token          (required for DMs)
 *   4. the app is installed on the Page, for webhooks       (required for comments to arrive)
 */
export async function connectAccount(input: {
  token: string
  igUserId: string
  pageId?: string
  workspace: string
  opsUserId: string
}): Promise<{ accountId: string; username: string; checks: ConnectCheck[] }> {
  const token = String(input.token ?? "").trim()
  const igUserId = String(input.igUserId ?? "").trim()
  if (token.length < 40 || /\s/.test(token)) throw new IgError("That does not look like an access token. Paste the whole token.")
  if (!/^\d{5,30}$/.test(igUserId)) throw new IgError("Enter the Instagram account id (the 1784… number).")
  const { rows: ws } = await metaDb().query(`SELECT 1 FROM meta.workspaces WHERE id = $1`, [input.workspace])
  if (!ws.length) throw new IgError(`Workspace ${input.workspace} does not exist.`)

  const checks: ConnectCheck[] = []
  let profile
  try {
    profile = await getIgAccount(igUserId, token)
    checks.push({ step: "Instagram account", ok: true, detail: `Token can read @${profile.username}.` })
  } catch (error) {
    throw new IgError(
      `The token cannot read Instagram account ${igUserId}: ${error instanceof Error ? error.message : error}. ` +
        "In Business Manager, assign the Instagram account (and its Page) to the system user, with instagram_basic."
    )
  }

  const info = await inspectToken(token)
  checks.push(
    info
      ? {
          step: "Token",
          ok: true,
          detail: `${info.expiresAt ? `Expires ${info.expiresAt.toISOString().slice(0, 10)}` : "Never expires"}. Permissions: ${
            info.scopes.join(", ") || "not reported"
          }.`,
        }
      : { step: "Token", ok: true, detail: "Meta did not report expiry or permissions for this token (not needed)." }
  )

  let page = null
  let pageError: string | null = null
  try {
    page = await findLinkedPage(igUserId, token, input.pageId?.trim() || undefined)
  } catch (error) {
    pageError = error instanceof Error ? error.message : String(error)
  }
  checks.push(
    page
      ? { step: "Facebook Page", ok: true, detail: `Linked Page "${page.name}" (${page.id}); Page token obtained.` }
      : {
          step: "Facebook Page",
          ok: false,
          detail: pageError
            ? `Could not read the linked Page: ${pageError}`
            : "No Page linked to this Instagram account was visible to the token. DMs need it: assign the Page to the system user " +
              "and add pages_show_list, pages_manage_metadata, pages_read_engagement and pages_messaging — or enter the Page id.",
        }
  )

  let subscribed = false
  if (page) {
    try {
      await subscribePage(page.id, page.access_token)
      subscribed = true
      checks.push({ step: "Webhooks", ok: true, detail: "App installed on the Page, so comment webhooks can be delivered." })
    } catch (error) {
      checks.push({
        step: "Webhooks",
        ok: false,
        detail: `Could not install the app on the Page (${error instanceof Error ? error.message : error}). Needs pages_manage_metadata.`,
      })
    }
  }

  /* The Page is an account of its own: it holds the Page token, and Facebook automation can use it later. */
  let pageAccountId: string | null = null
  if (page) {
    const { rows } = await metaDb().query(
      `INSERT INTO meta.accounts (workspace_id, platform, external_id, username, display_name, status, webhook_subscribed, connected_by)
       VALUES ($1, 'facebook', $2, NULL, $3, 'active', $4, $5)
       ON CONFLICT (platform, external_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, status = 'active', webhook_subscribed = EXCLUDED.webhook_subscribed,
         last_error = NULL, updated_at = NOW()
       WHERE meta.accounts.workspace_id = EXCLUDED.workspace_id
       RETURNING id`,
      [input.workspace, page.id, page.name, subscribed, input.opsUserId]
    )
    if (!rows[0]) throw new IgError(`The Page "${page.name}" is already connected to another workspace.`, 409)
    pageAccountId = rows[0].id
    await setCredential(pageAccountId!, "page_token", page.access_token, { by: input.opsUserId })
  }

  const { rows } = await metaDb().query(
    `INSERT INTO meta.accounts
       (workspace_id, platform, external_id, username, display_name, linked_account_id, status, webhook_subscribed,
        last_checked_at, connected_by)
     VALUES ($1, 'instagram', $2, $3, $4, $5, 'active', $6, NOW(), $7)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       username = EXCLUDED.username, display_name = EXCLUDED.display_name, linked_account_id = EXCLUDED.linked_account_id,
       status = 'active', webhook_subscribed = EXCLUDED.webhook_subscribed, last_error = NULL, last_checked_at = NOW(),
       connected_by = EXCLUDED.connected_by, updated_at = NOW()
     WHERE meta.accounts.workspace_id = EXCLUDED.workspace_id
     RETURNING id, username`,
    [input.workspace, profile.id, profile.username, profile.name ?? null, pageAccountId, subscribed, input.opsUserId]
  )
  /* A conflict with another workspace's row updates nothing: one Instagram account cannot be taken
     over by a second tenant. */
  if (!rows[0]) throw new IgError(`@${profile.username} is already connected to another workspace.`, 409)
  await setCredential(rows[0].id, "system_user_token", token, {
    scopes: info?.scopes ?? [],
    expiresAt: info?.expiresAt ?? null,
    by: input.opsUserId,
  })
  await logExec(rows[0].id, "connected", { detail: checks.map((c) => `${c.ok ? "✓" : "✕"} ${c.step}`).join(", ") })
  return { accountId: rows[0].id, username: rows[0].username, checks }
}

export async function disconnectAccount(accountId: string): Promise<void> {
  const a = await account(accountId)
  const ids = [a.id, a.linked_account_id].filter(Boolean)
  await metaDb().query(`UPDATE meta.credentials SET revoked_at = NOW() WHERE account_id = ANY($1) AND revoked_at IS NULL`, [ids])
  await metaDb().query(`UPDATE meta.accounts SET status = 'disconnected', updated_at = NOW() WHERE id = ANY($1)`, [ids])
  await metaDb().query(`UPDATE meta.campaigns SET status = 'paused', updated_at = NOW() WHERE account_id = $1 AND status = 'active'`, [
    accountId,
  ])
  await logExec(accountId, "disconnected")
}

/**
 * The daily health check that replaces token refresh. A system-user token does not expire, but it
 * can be revoked, the system user removed, or the account unassigned; this finds that once a day.
 */
export async function checkAccounts(): Promise<{ ok: number; failed: number }> {
  const { rows } = await metaDb().query(
    `SELECT a.* FROM meta.accounts a
      WHERE a.platform = 'instagram' AND a.status IN ('active', 'expired')
        AND EXISTS (SELECT 1 FROM meta.credentials c WHERE c.account_id = a.id AND c.kind = 'system_user_token' AND c.revoked_at IS NULL)`
  )
  let ok = 0
  let failed = 0
  for (const a of rows as AccountRow[]) {
    try {
      const p = await getIgAccount(a.external_id, (await credential(a.id, "system_user_token"))!)
      await metaDb().query(
        `UPDATE meta.accounts SET username = $2, status = 'active', last_error = NULL, last_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [a.id, p.username]
      )
      ok++
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof IgApiError && error.tokenInvalid) await markTokenDead(a.id, message)
      else
        await metaDb().query(`UPDATE meta.accounts SET last_error = $2, last_checked_at = NOW(), updated_at = NOW() WHERE id = $1`, [
          a.id,
          `Daily check failed: ${message}`.slice(0, 500),
        ])
    }
  }
  return { ok, failed }
}

export async function getSettings(accountId: string): Promise<AutomationSettings> {
  return mergeSettings((await account(accountId)).settings)
}

export async function saveSettings(accountId: string, input: unknown): Promise<AutomationSettings> {
  const merged = mergeSettings({ ...(await getSettings(accountId)), ...(input as object) })
  await metaDb().query(`UPDATE meta.accounts SET settings = $2, updated_at = NOW() WHERE id = $1`, [accountId, JSON.stringify(merged)])
  await logExec(accountId, "settings_saved", { detail: `mode ${merged.replyMode}, AI ${merged.aiEnabled ? "on" : "off"}` })
  return merged
}

/* ── Media (the context the AI reads) ──────────────────────────────────────────────────────── */

async function upsertMedia(accountId: string, m: { id: string; caption?: string; permalink?: string; media_type?: string; media_product_type?: string; thumbnail_url?: string; media_url?: string; timestamp?: string }) {
  await metaDb().query(
    `INSERT INTO meta.media (account_id, external_id, caption, permalink, media_type, product_type, thumbnail_url, posted_at, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (account_id, external_id) DO UPDATE SET
       caption = EXCLUDED.caption, permalink = EXCLUDED.permalink, media_type = EXCLUDED.media_type,
       product_type = EXCLUDED.product_type, thumbnail_url = EXCLUDED.thumbnail_url, posted_at = EXCLUDED.posted_at, fetched_at = NOW()`,
    [
      accountId,
      m.id,
      m.caption ?? null,
      m.permalink ?? null,
      m.media_type ?? null,
      m.media_product_type ?? null,
      m.thumbnail_url || (m.media_type === "IMAGE" ? m.media_url : null) || null,
      m.timestamp ? new Date(m.timestamp) : null,
    ]
  )
}

export async function syncMedia(accountId: string) {
  const a = await account(accountId)
  let media
  try {
    media = await listMedia(a.external_id, await systemToken(a), 50)
  } catch (error) {
    if (error instanceof IgApiError && error.tokenInvalid) await markTokenDead(a.id, error.message)
    throw new IgError(`Could not load posts from Instagram: ${error instanceof Error ? error.message : error}`)
  }
  for (const m of media) await upsertMedia(a.id, m)
  return { count: media.length }
}

export async function saveMediaNote(accountId: string, mediaId: string, note: string) {
  const { rowCount } = await metaDb().query(`UPDATE meta.media SET notes = $3 WHERE account_id = $1 AND external_id = $2`, [
    accountId,
    mediaId,
    String(note ?? "").trim().slice(0, 1500) || null,
  ])
  if (!rowCount) throw new IgError("That post is not in the list yet — refresh posts first.")
}

/** Caption + note for one post; fetched from Instagram and cached the first time it is needed. */
async function mediaContext(a: AccountRow, mediaId: string | null): Promise<{ caption: string | null; note: string | null }> {
  if (!mediaId) return { caption: null, note: null }
  const { rows } = await metaDb().query(`SELECT caption, notes FROM meta.media WHERE account_id = $1 AND external_id = $2`, [a.id, mediaId])
  if (rows[0]) return { caption: rows[0].caption, note: rows[0].notes }
  try {
    const m = await getMedia(mediaId, await systemToken(a))
    await upsertMedia(a.id, m)
    return { caption: m.caption ?? null, note: null }
  } catch {
    return { caption: null, note: null }
  }
}

/* ── Response templates ────────────────────────────────────────────────────────────────────── */

export async function saveTemplate(input: { id?: string; workspace: string; name: string; channel: string; body: string; opsUserId: string }) {
  const name = String(input.name ?? "").trim().slice(0, 120)
  const body = String(input.body ?? "").trim()
  const channel = ["reply", "dm", "any"].includes(input.channel) ? input.channel : "any"
  if (!name) throw new IgError("Name the saved reply.")
  if (!body || body.length > 900) throw new IgError("The reply must be 1–900 characters.")
  if (channel === "reply" && /https?:\/\//i.test(body)) throw new IgError("Keep links out of public replies.")
  if (input.id) {
    const { rowCount } = await metaDb().query(
      `UPDATE meta.response_templates SET name = $2, channel = $3, body = $4, updated_at = NOW() WHERE id = $1 AND workspace_id = $5`,
      [input.id, name, channel, body, input.workspace]
    )
    if (!rowCount) throw new IgError("That saved reply no longer exists.", 404)
    return { id: input.id }
  }
  const { rows } = await metaDb().query(
    `INSERT INTO meta.response_templates (workspace_id, name, channel, body, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.workspace, name, channel, body, input.opsUserId]
  )
  return rows[0] as { id: string }
}

export async function archiveTemplate(id: string, workspace: string) {
  await metaDb().query(`UPDATE meta.response_templates SET archived_at = NOW() WHERE id = $1 AND workspace_id = $2`, [id, workspace])
}

/* ── Campaigns ─────────────────────────────────────────────────────────────────────────────── */

type TriggerKind = "keyword" | "intent" | "any_comment"

interface CampaignRow {
  id: string
  account_id: string
  name: string
  media_ids: string[] | null
  link_url: string | null
  resource_name: string | null
  once_per_person: boolean
  daily_dm_cap: number
  priority: number
  /* The trigger this lookup matched on. */
  match_mode: MatchMode
  keywords: string[]
  intent: string | null
  /* kind → message versions; hide has none. */
  actions: { dm?: string[]; reply?: string[]; hide?: string[] }
}

interface TriggerInput {
  kind: TriggerKind
  matchMode?: MatchMode
  keywords?: unknown
  intent?: string
}

/**
 * Creates or replaces a campaign with its triggers and actions, in one transaction — a campaign is
 * never visible half-saved, with its old triggers gone and its new ones not yet written.
 */
export async function saveCampaign(input: Record<string, any> & { accountId: string; opsUserId: string }) {
  const name = String(input.name ?? "").trim().slice(0, 120)
  if (!name) throw new IgError("Give the campaign a name.")

  const rawTriggers: TriggerInput[] = Array.isArray(input.triggers) ? input.triggers : []
  const triggers = rawTriggers
    .filter((t) => ["keyword", "intent", "any_comment"].includes(t?.kind))
    .map((t) => ({
      kind: t.kind,
      matchMode: (["exact", "word", "contains"].includes(String(t.matchMode)) ? t.matchMode : "word") as MatchMode,
      keywords: t.kind === "keyword" ? cleanKeywords(t.keywords) : [],
      intent: t.kind === "intent" ? String(t.intent ?? "").trim().slice(0, 600) : null,
    }))
  const kinds = new Set(triggers.map((t) => t.kind))
  if (!triggers.length) throw new IgError("Choose when the campaign fires.")
  if (kinds.size !== triggers.length) throw new IgError("Each kind of trigger can be used once per campaign.")
  if (kinds.has("any_comment") && kinds.size > 1) throw new IgError("“Any comment” already covers keywords and intent — use it on its own.")
  for (const t of triggers) {
    if (t.kind === "keyword" && !t.keywords.length) throw new IgError("Add at least one keyword.")
    if (t.kind === "intent" && (!t.intent || t.intent.length < 3))
      throw new IgError("Describe what people are asking for, e.g. “wants the 2027 Aahar Calendar PDF”.")
  }

  const mediaIds = Array.isArray(input.mediaIds) ? input.mediaIds.map(String).filter((m: string) => /^\d{5,30}$/.test(m)).slice(0, 100) : []
  if (kinds.has("any_comment") && !mediaIds.length)
    throw new IgError("“Any comment” campaigns must be limited to posts you pick — choose at least one.")

  const respond = ["dm", "reply", "both"].includes(input.respondWith) ? input.respondWith : "dm"
  const dmTexts = respond === "reply" ? [] : cleanTemplates(input.dmTemplates, 10, 900)
  const replyTexts = respond === "dm" ? [] : cleanTemplates(input.replyTemplates, 15, 300)
  const hide = input.hideAfter === true
  if (respond !== "reply" && !dmTexts.length) throw new IgError("Write at least one DM message.")
  if (respond !== "dm" && !replyTexts.length) throw new IgError("Write at least one public reply.")

  const linkUrl = String(input.linkUrl ?? "").trim() || null
  const resourceName = String(input.resourceName ?? "").trim().slice(0, 160) || null
  if (linkUrl && !/^https:\/\/[^\s]+$/i.test(linkUrl)) throw new IgError("The link must start with https://")
  if ([...dmTexts, ...replyTexts].some((t) => t.includes("{link}")) && !linkUrl) throw new IgError("A message uses {link} but no link is set.")
  if (replyTexts.some((t) => /https?:\/\//i.test(t) || t.includes("{link}")))
    throw new IgError("Keep links out of public replies — Instagram treats links in comments as spam. Put them in the DM.")

  const starts = input.startsAt ? new Date(input.startsAt) : null
  const ends = input.endsAt ? new Date(input.endsAt) : null
  if ((starts && isNaN(+starts)) || (ends && isNaN(+ends))) throw new IgError("The start or end date is not a date.")
  if (starts && ends && ends <= starts) throw new IgError("The end must be after the start.")

  const cap = Math.min(5000, Math.max(1, Math.round(Number(input.dailyDmCap) || 500)))
  const priority = Math.min(1000, Math.max(1, Math.round(Number(input.priority) || 100)))
  const oncePerPerson = kinds.has("any_comment") ? true : input.oncePerPerson !== false
  const status = ["active", "paused", "archived"].includes(input.status) ? input.status : "paused"

  await account(input.accountId)

  const db = await metaDb().connect()
  try {
    await db.query("BEGIN")
    const values = [input.accountId, name, status, mediaIds.length ? mediaIds : null, linkUrl, resourceName, oncePerPerson, cap, priority, starts, ends]
    let id: string
    if (input.campaignId) {
      const { rows } = await db.query(
        `UPDATE meta.campaigns SET (account_id, name, status, media_ids, link_url, resource_name, once_per_person, daily_dm_cap,
            priority, starts_at, ends_at, updated_at) = ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         WHERE id = $12 RETURNING id`,
        [...values, input.campaignId]
      )
      if (!rows[0]) throw new IgError("That campaign no longer exists.", 404)
      id = rows[0].id
      await db.query(`DELETE FROM meta.campaign_triggers WHERE campaign_id = $1`, [id])
      await db.query(`DELETE FROM meta.campaign_actions WHERE campaign_id = $1`, [id])
    } else {
      const { rows } = await db.query(
        `INSERT INTO meta.campaigns (account_id, name, status, media_ids, link_url, resource_name, once_per_person, daily_dm_cap,
            priority, starts_at, ends_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [...values, input.opsUserId]
      )
      id = rows[0].id
    }
    for (const t of triggers) {
      await db.query(
        `INSERT INTO meta.campaign_triggers (campaign_id, kind, match_mode, keywords, intent) VALUES ($1, $2, $3, $4, $5)`,
        [id, t.kind, t.matchMode, t.keywords, t.intent]
      )
    }
    let position = 1
    if (dmTexts.length) await db.query(`INSERT INTO meta.campaign_actions (campaign_id, kind, position, texts) VALUES ($1, 'dm', $2, $3)`, [id, position++, dmTexts])
    if (replyTexts.length) await db.query(`INSERT INTO meta.campaign_actions (campaign_id, kind, position, texts) VALUES ($1, 'reply', $2, $3)`, [id, position++, replyTexts])
    if (hide) await db.query(`INSERT INTO meta.campaign_actions (campaign_id, kind, position) VALUES ($1, 'hide', $2)`, [id, position++])
    await db.query("COMMIT")
    await logExec(input.accountId, input.campaignId ? "campaign_updated" : "campaign_created", { campaignId: id, detail: `${name} (${status})` })
    return { id }
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    db.release()
  }
}

export async function setCampaignStatus(id: string, status: string): Promise<void> {
  if (!["active", "paused", "archived"].includes(status)) throw new IgError("Unknown status.")
  const { rows } = await metaDb().query(
    `UPDATE meta.campaigns SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING account_id, name`,
    [id, status]
  )
  if (!rows[0]) throw new IgError("That campaign no longer exists.", 404)
  await logExec(rows[0].account_id, `campaign_${status}`, { campaignId: id, detail: rows[0].name })
}

/** A copy with its triggers and actions, paused, named "… (copy)" — the safe start for a variant. */
export async function duplicateCampaign(id: string, opsUserId: string) {
  const db = await metaDb().connect()
  try {
    await db.query("BEGIN")
    const { rows } = await db.query(
      `INSERT INTO meta.campaigns (account_id, name, status, media_ids, link_url, resource_name, once_per_person, daily_dm_cap,
          priority, starts_at, ends_at, created_by)
       SELECT account_id, left(name, 112) || ' (copy)', 'paused', media_ids, link_url, resource_name, once_per_person, daily_dm_cap,
              priority, starts_at, ends_at, $2
         FROM meta.campaigns WHERE id = $1
       RETURNING id, account_id`,
      [id, opsUserId]
    )
    if (!rows[0]) throw new IgError("That campaign no longer exists.", 404)
    const copy = rows[0].id
    await db.query(
      `INSERT INTO meta.campaign_triggers (campaign_id, kind, match_mode, keywords, intent)
       SELECT $2, kind, match_mode, keywords, intent FROM meta.campaign_triggers WHERE campaign_id = $1`,
      [id, copy]
    )
    await db.query(
      `INSERT INTO meta.campaign_actions (campaign_id, kind, position, texts)
       SELECT $2, kind, position, texts FROM meta.campaign_actions WHERE campaign_id = $1`,
      [id, copy]
    )
    await db.query("COMMIT")
    await logExec(rows[0].account_id, "campaign_duplicated", { campaignId: copy, detail: `from ${id}` })
    return { id: copy as string }
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    db.release()
  }
}

/** Live campaigns with a trigger of this kind, applicable to this post, best first. */
async function liveCampaigns(accountId: string, kind: TriggerKind, mediaId: string | null): Promise<CampaignRow[]> {
  const { rows } = await metaDb().query(
    `SELECT c.*, t.match_mode, t.keywords, t.intent,
            COALESCE((SELECT json_object_agg(a.kind, a.texts) FROM meta.campaign_actions a WHERE a.campaign_id = c.id), '{}'::json) AS actions
       FROM meta.campaigns c
       JOIN meta.campaign_triggers t ON t.campaign_id = c.id AND t.kind = $2
      WHERE c.account_id = $1 AND c.status = 'active'
        AND (c.starts_at IS NULL OR c.starts_at <= NOW()) AND (c.ends_at IS NULL OR c.ends_at > NOW())
        AND (c.media_ids IS NULL OR $3::text = ANY(c.media_ids))
      ORDER BY c.priority, c.created_at`,
    [accountId, kind, mediaId]
  )
  return rows
}

/**
 * Every live campaign that gives something away (a DM or a reply), on any post — what the AI may
 * hand out when a comment asks for it. Wider than the triggers on purpose: someone who writes
 * "calander kaise milega?" under a different reel is asking for the calendar all the same. Campaigns
 * on this post come first; a new campaign is included the moment it goes live.
 */
async function offerCampaigns(accountId: string, mediaId: string | null): Promise<(CampaignRow & { on_this_post: boolean })[]> {
  const { rows } = await metaDb().query(
    `SELECT c.*, 'word' AS match_mode,
            COALESCE((SELECT array_agg(DISTINCT k) FROM meta.campaign_triggers t, unnest(t.keywords) k WHERE t.campaign_id = c.id), '{}') AS keywords,
            (SELECT string_agg(t.intent, ' / ') FROM meta.campaign_triggers t WHERE t.campaign_id = c.id AND COALESCE(t.intent, '') <> '') AS intent,
            (c.media_ids IS NULL OR $2::text = ANY(c.media_ids)) AS on_this_post,
            COALESCE((SELECT json_object_agg(a.kind, a.texts) FROM meta.campaign_actions a WHERE a.campaign_id = c.id), '{}'::json) AS actions
       FROM meta.campaigns c
      WHERE c.account_id = $1 AND c.status = 'active'
        AND (c.starts_at IS NULL OR c.starts_at <= NOW()) AND (c.ends_at IS NULL OR c.ends_at > NOW())
        AND EXISTS (SELECT 1 FROM meta.campaign_actions a WHERE a.campaign_id = c.id AND a.kind IN ('dm', 'reply'))
      ORDER BY on_this_post DESC, c.priority, c.created_at
      LIMIT 25`,
    [accountId, mediaId]
  )
  return rows
}

function describeOffer(c: CampaignRow & { on_this_post: boolean }): string {
  return [
    c.name,
    c.resource_name ? `Gives: ${c.resource_name}.` : null,
    c.intent ? `For people who: ${c.intent}.` : null,
    c.keywords.length ? `People ask with words like: ${c.keywords.slice(0, 12).join(", ")}.` : null,
    c.on_this_post ? "Runs on this post." : "Runs on other posts — still the right answer if they ask for it here.",
  ]
    .filter(Boolean)
    .join(" ")
}

/* ── Webhook intake ────────────────────────────────────────────────────────────────────────── */

export interface IntakeResult {
  queue: string[]
  triage: string[]
}

/**
 * Everything in one webhook delivery. Stores what arrived and returns the work to do next; the
 * caller answers Meta first and does the work after, so a slow API never looks like a dead webhook.
 */
export async function recordWebhook(body: any): Promise<IntakeResult> {
  const result: IntakeResult = { queue: [], triage: [] }
  if (body?.object !== "instagram" || !Array.isArray(body?.entry)) {
    await logEvent(null, null, "not_instagram")
    return result
  }

  for (const entry of body.entry) {
    const igUserId = String(entry?.id ?? "")
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field === "comments" || change?.field === "live_comments") {
        try {
          const r = await intakeComment(igUserId, change.value)
          result.queue.push(...r.queue)
          result.triage.push(...r.triage)
        } catch (error) {
          if (isMissingSchema(error)) {
            console.error("[meta] schema missing — apply migration 1729400000000-CreateMetaIntegrations")
            return result
          }
          console.error(`[meta] comment not recorded: ${error instanceof Error ? error.message : error}`)
          await logEvent(igUserId, change.field, "error", change.value)
        }
      } else {
        await logEvent(igUserId, String(change?.field ?? ""), "not_handled")
      }
    }
    if (Array.isArray(entry?.messaging) && entry.messaging.length) {
      try {
        await intakeMessages(igUserId, entry.messaging)
      } catch (error) {
        if (isMissingSchema(error)) return result
        console.error(`[meta] messages not recorded: ${error instanceof Error ? error.message : error}`)
        await logEvent(igUserId, "messages", "error")
      }
    }
  }
  return result
}

async function accountByExternal(igUserId: string): Promise<AccountRow | undefined> {
  const { rows } = await metaDb().query(
    `SELECT * FROM meta.accounts WHERE platform = 'instagram' AND external_id = $1 AND status <> 'disconnected'`,
    [igUserId]
  )
  return rows[0]
}

async function intakeComment(igUserId: string, value: any): Promise<IntakeResult> {
  const none: IntakeResult = { queue: [], triage: [] }
  const commentId = String(value?.id ?? "")
  const fromId = String(value?.from?.id ?? "")
  if (!commentId || !fromId) {
    await logEvent(igUserId, "comments", "malformed")
    return none
  }
  const a = await accountByExternal(igUserId)
  if (!a) {
    await logEvent(igUserId, "comments", "unknown_account")
    return none
  }
  /* Our own comments and replies — including the public replies this system posts. */
  if (fromId === igUserId) {
    await logEvent(igUserId, "comments", "own_comment")
    return none
  }

  const mediaId = value?.media?.id ? String(value.media.id) : null
  const { rows } = await metaDb().query(
    `INSERT INTO meta.comments (account_id, comment_id, media_id, parent_id, commenter_id, commenter_username, text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (account_id, comment_id) DO NOTHING
     RETURNING *`,
    [
      a.id,
      commentId,
      mediaId,
      value?.parent_id ? String(value.parent_id) : null,
      fromId,
      value?.from?.username ? String(value.from.username).slice(0, 255) : null,
      String(value?.text ?? "").slice(0, 2200),
    ]
  )
  const comment: CommentRow | undefined = rows[0]
  if (!comment) {
    await logEvent(igUserId, "comments", "duplicate")
    return none
  }
  await logExec(a.id, "comment_received", { commentRowId: comment.id })

  const settings = mergeSettings(a.settings)

  /**
   * Keyword campaigns first: a keyword is an explicit request, answered at once with no AI in the
   * way. The AI still reads the comment afterwards (when on), because "I have PCOD, what should I
   * take? also send the calendar" asked two things — the campaign answers one, and the reading makes
   * sure a person sees the other.
   */
  for (const c of await liveCampaigns(a.id, "keyword", mediaId)) {
    const keyword = matchKeyword(comment.text, c.keywords, c.match_mode)
    if (keyword) {
      await logEvent(igUserId, "comments", "campaign_keyword")
      const queue = await applyCampaign(a, comment, c, `keyword:${keyword}`.slice(0, 24))
      if (!settings.aiEnabled) return { queue, triage: [] }
      await metaDb().query(`UPDATE meta.comments SET ai_status = 'pending' WHERE id = $1`, [comment.id])
      return { queue, triage: [comment.id] }
    }
  }

  if (settings.aiEnabled) {
    await metaDb().query(`UPDATE meta.comments SET ai_status = 'pending' WHERE id = $1`, [comment.id])
    await logEvent(igUserId, "comments", "to_ai")
    return { queue: [], triage: [comment.id] }
  }
  await logEvent(igUserId, "comments", "inbox")
  return none
}

/**
 * Direct messages: stored in conversations. Our own sends come back as echoes with the message id
 * we already stored, and fall away on the unique index.
 */
async function intakeMessages(igUserId: string, events: any[]) {
  const a = await accountByExternal(igUserId)
  if (!a) {
    await logEvent(igUserId, "messages", "unknown_account")
    return
  }
  for (const ev of events) {
    const m = ev?.message
    if (!m?.mid) {
      await logEvent(igUserId, "messages", "not_handled")
      continue
    }
    const echo = Boolean(m.is_echo)
    const participant = String(echo ? ev?.recipient?.id ?? "" : ev?.sender?.id ?? "")
    if (!participant || participant === igUserId) continue
    const at = ev?.timestamp ? new Date(Number(ev.timestamp)) : new Date()

    const conversationId = await upsertConversation(a.id, participant, null, echo ? "out" : "in", at)
    const { rowCount } = await metaDb().query(
      `INSERT INTO meta.messages (account_id, conversation_id, direction, external_id, text, attachments, source, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
      [
        a.id,
        conversationId,
        echo ? "out" : "in",
        String(m.mid),
        typeof m.text === "string" ? m.text.slice(0, 4000) : null,
        Array.isArray(m.attachments) ? JSON.stringify(m.attachments) : null,
        echo ? "echo" : "user",
        at,
      ]
    )
    if (rowCount && !echo) {
      await metaDb().query(`UPDATE meta.conversations SET unread = unread + 1 WHERE id = $1`, [conversationId])
    }
    await logEvent(igUserId, "messages", echo ? (rowCount ? "message_echo" : "own_message") : "message_in")
  }
}

async function upsertConversation(accountId: string, participantId: string, username: string | null, direction: "in" | "out", at: Date) {
  const { rows } = await metaDb().query(
    `INSERT INTO meta.conversations (account_id, participant_id, participant_username, last_message_at, last_inbound_at, last_outbound_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 = 'in' THEN $4::timestamptz END, CASE WHEN $5 = 'out' THEN $4::timestamptz END)
     ON CONFLICT (account_id, participant_id) DO UPDATE SET
       participant_username = COALESCE(EXCLUDED.participant_username, meta.conversations.participant_username),
       last_message_at = GREATEST(meta.conversations.last_message_at, EXCLUDED.last_message_at),
       last_inbound_at = GREATEST(meta.conversations.last_inbound_at, EXCLUDED.last_inbound_at),
       last_outbound_at = GREATEST(meta.conversations.last_outbound_at, EXCLUDED.last_outbound_at),
       status = 'open'
     RETURNING id`,
    [accountId, participantId, username, at, direction]
  )
  return rows[0].id as string
}

/* ── Campaign actions ──────────────────────────────────────────────────────────────────────── */

interface CommentRow {
  id: string
  account_id: string
  comment_id: string
  media_id: string | null
  parent_id: string | null
  commenter_id: string
  commenter_username: string | null
  text: string
  commented_at: Date
  status: string
  campaign_id: string | null
  ai_status: string
  ai_attempts: number
  ai_draft: string | null
}

function pick<T>(list: T[] | undefined): T | null {
  return list && list.length ? list[Math.floor(Math.random() * list.length)] : null
}

function render(template: string, comment: { commenter_username: string | null }, c?: Pick<CampaignRow, "link_url" | "resource_name">) {
  return template
    .replace(/\{username\}/g, comment.commenter_username ? `@${comment.commenter_username}` : "")
    .replace(/\{link\}/g, c?.link_url ?? "")
    .replace(/\{resource\}/g, c?.resource_name ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

async function enqueue(
  a: AccountRow,
  kind: "dm" | "reply" | "hide" | "message",
  source: string,
  targetId: string,
  opts: { commentRowId?: string; conversationId?: string; campaignId?: string | null; text?: string | null; createdBy?: string | null }
): Promise<string | null> {
  const { rows } = await metaDb().query(
    `INSERT INTO meta.response_queue (account_id, kind, source, target_id, comment_row_id, conversation_id, campaign_id, text, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (account_id, target_id, kind) WHERE kind IN ('dm', 'reply', 'hide') DO NOTHING
     RETURNING id`,
    [a.id, kind, source, targetId, opts.commentRowId ?? null, opts.conversationId ?? null, opts.campaignId ?? null, opts.text ?? null, opts.createdBy ?? null]
  )
  const id = rows[0]?.id ?? null
  if (id) await logExec(a.id, `queued_${kind}`, { campaignId: opts.campaignId, commentRowId: opts.commentRowId, queueId: id, detail: source })
  return id
}

/** Queues a campaign's actions for one comment, within its limits. */
async function applyCampaign(a: AccountRow, comment: CommentRow, c: CampaignRow, matchedBy: string): Promise<string[]> {
  const notes: string[] = []
  let doDm = Boolean(c.actions.dm?.length)
  let replyOnly = !doDm && Boolean(c.actions.reply?.length)
  const ref = { campaignId: c.id, commentRowId: comment.id }
  await logExec(a.id, "campaign_matched", { ...ref, detail: `${c.name} via ${matchedBy}` })

  /* Once per person covers whatever the campaign sends — a DM, or for reply-only campaigns the reply. */
  if (c.once_per_person) {
    const { rows } = await metaDb().query(
      `SELECT 1 FROM meta.response_queue q JOIN meta.comments m ON m.id = q.comment_row_id
        WHERE q.campaign_id = $1 AND q.kind IN ('dm', 'reply') AND q.status IN ('pending', 'sending', 'sent')
          AND m.commenter_id = $2 AND m.id <> $3 LIMIT 1`,
      [c.id, comment.commenter_id, comment.id]
    )
    if (rows.length) {
      doDm = false
      replyOnly = false
      notes.push("Already answered this person for this campaign.")
    }
  }
  if (doDm) {
    const { rows } = await metaDb().query(
      `SELECT COUNT(*)::int AS n FROM meta.response_queue WHERE campaign_id = $1 AND kind = 'dm' AND created_at > NOW() - INTERVAL '24 hours'`,
      [c.id]
    )
    if (rows[0].n >= c.daily_dm_cap) {
      doDm = false
      notes.push(`Daily DM limit of ${c.daily_dm_cap} reached.`)
    }
  }
  if (doDm && Date.now() - new Date(comment.commented_at).getTime() > SEVEN_DAYS_MS - 60_000) {
    doDm = false
    notes.push("Older than 7 days — Instagram no longer allows a DM.")
  }
  for (const n of notes) await logExec(a.id, "action_skipped", { ...ref, detail: n })

  const ids: string[] = []
  if (doDm) {
    const id = await enqueue(a, "dm", "campaign", comment.comment_id, { ...ref, text: render(pick(c.actions.dm)!, comment, c) })
    if (id) ids.push(id)
  }
  /* A repeat commenter whose DM was skipped gets no public reply either: "sent you a DM" would be false. */
  if (c.actions.reply?.length && (doDm || replyOnly)) {
    const id = await enqueue(a, "reply", "campaign", comment.comment_id, { ...ref, text: render(pick(c.actions.reply)!, comment, c) })
    if (id) ids.push(id)
  }
  if (c.actions.hide) {
    const id = await enqueue(a, "hide", "campaign", comment.comment_id, { ...ref })
    if (id) ids.push(id)
  }

  await metaDb().query(
    `UPDATE meta.comments SET status = $5, campaign_id = $2, matched_by = $3, note = $4, handled_by = 'campaign', handled_at = NOW()
      WHERE id = $1`,
    [comment.id, c.id, matchedBy, notes.join(" ") || null, c.actions.hide ? "hidden" : "campaign"]
  )
  return ids
}

/* ── AI triage ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Reads one comment with AI, then decides where it goes:
 *   already answered by a keyword campaign → flagged for a person if sensitive, nothing else
 *   spam / abuse                 → spam (hidden if the setting says so), no reply
 *   asks for an intent campaign  → that campaign
 *   any-comment campaign on post → that campaign, if the comment is a safe, positive, top-level one
 *   otherwise                    → needs a person / awaiting approval / automatic reply
 */
export async function triageComment(commentRowId: string): Promise<string[]> {
  const { rows } = await metaDb().query(
    `UPDATE meta.comments SET ai_status = 'running', ai_attempts = ai_attempts + 1 WHERE id = $1 AND ai_status = 'pending' RETURNING *`,
    [commentRowId]
  )
  const comment: CommentRow | undefined = rows[0]
  if (!comment) return []
  const a = await account(comment.account_id)
  const settings = mergeSettings(a.settings)

  const { rows: used } = await metaDb().query(
    `SELECT COUNT(*)::int AS n FROM meta.comments
      WHERE account_id = $1 AND ai_at > date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
    [a.id]
  )
  if (used[0].n >= settings.aiDailyLimit) {
    await metaDb().query(
      `UPDATE meta.comments SET ai_status = 'skipped', note = COALESCE(note, 'Daily AI limit reached — handle manually.') WHERE id = $1`,
      [comment.id]
    )
    await logExec(a.id, "ai_skipped", { commentRowId: comment.id, detail: "daily limit" })
    return []
  }

  const intents = comment.campaign_id ? [] : await offerCampaigns(a.id, comment.media_id)
  const anyComment = comment.campaign_id ? [] : await liveCampaigns(a.id, "any_comment", comment.media_id)
  const ctx = await mediaContext(a, comment.media_id)

  let reading: CommentReading & { model: string }
  try {
    reading = await readComment({
      settings,
      comment: comment.text,
      commenter: comment.commenter_username,
      caption: ctx.caption,
      postNote: ctx.note,
      isReplyToAnother: Boolean(comment.parent_id),
      intents: intents.map((c) => ({ id: c.id, description: describeOffer(c) })),
      draft: settings.replyMode !== "manual" && !comment.campaign_id,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const final = error instanceof AiUnavailable || comment.ai_attempts >= MAX_AI_ATTEMPTS
    /* A campaign's note ("already sent to this person") outranks "AI failed". */
    await metaDb().query(
      `UPDATE meta.comments SET ai_status = $2, note = CASE WHEN campaign_id IS NULL THEN $3 ELSE note END WHERE id = $1`,
      [comment.id, final ? "failed" : "pending", `AI reading failed: ${message}`.slice(0, 500)]
    )
    await logExec(a.id, "ai_failed", { commentRowId: comment.id, detail: message })
    return []
  }

  await metaDb().query(
    `UPDATE meta.comments
        SET ai_status = 'done', ai_category = $2, ai_sentiment = $3, ai_risk = $4, ai_language = $5, ai_needs_human = $6,
            ai_reason = $7, ai_draft = $8, ai_model = $9, ai_at = NOW(),
            note = CASE WHEN campaign_id IS NULL THEN NULL ELSE note END
      WHERE id = $1`,
    [comment.id, reading.category, reading.sentiment, reading.risk, reading.language, reading.needsHuman, reading.reason, reading.reply, reading.model]
  )
  await logExec(a.id, "ai_read", {
    commentRowId: comment.id,
    detail: `${reading.category}, ${reading.sentiment}, ${reading.risk} risk${reading.needsHuman ? ", needs a person" : ""} — ${reading.reason}`,
  })
  comment.ai_draft = reading.reply
  return routeAfterReading(a, settings, comment, reading, intents, anyComment)
}

async function setStatus(commentId: string, status: string, extra: { handledBy?: string; note?: string } = {}) {
  await metaDb().query(
    `UPDATE meta.comments SET status = $2,
            handled_by = COALESCE($3, handled_by), handled_at = CASE WHEN $3::text IS NULL THEN handled_at ELSE NOW() END,
            note = COALESCE($4, note)
      WHERE id = $1`,
    [commentId, status, extra.handledBy ?? null, extra.note ?? null]
  )
}

async function routeAfterReading(
  a: AccountRow,
  settings: AutomationSettings,
  comment: CommentRow,
  r: CommentReading,
  intents: CampaignRow[],
  anyComment: CampaignRow[]
): Promise<string[]> {
  const unsafe = NEVER_AUTO.includes(r.category) || r.risk === "high"
  const ref = { commentRowId: comment.id }

  if (comment.campaign_id) {
    if (unsafe || r.needsHuman) {
      await metaDb().query(
        `UPDATE meta.comments SET status = 'needs_human',
                note = concat_ws(' ', note, 'The campaign answered the request; the comment also needs a person.')
          WHERE id = $1`,
        [comment.id]
      )
      await logExec(a.id, "routed_needs_human", { ...ref, campaignId: comment.campaign_id, detail: "campaign comment also sensitive" })
    }
    return []
  }

  if (r.category === "spam" || r.category === "abusive") {
    if (settings.autoHideSpam) {
      const id = await enqueue(a, "hide", "moderation", comment.comment_id, { commentRowId: comment.id, createdBy: "ai" })
      await setStatus(comment.id, "hidden", { handledBy: "ai" })
      return id ? [id] : []
    }
    await setStatus(comment.id, "spam")
    await logExec(a.id, "routed_spam", ref)
    return []
  }

  if (r.intentCampaignId && !unsafe) {
    const c = intents.find((x) => x.id === r.intentCampaignId)
    if (c) return applyCampaign(a, comment, c, "intent")
  }

  const anyOk =
    !comment.parent_id && !unsafe && !r.needsHuman && r.risk === "low" && r.sentiment !== "negative" &&
    (["request", "praise", "question", "other"] as Category[]).includes(r.category)
  if (anyOk && anyComment.length) return applyCampaign(a, comment, anyComment[0], "any_comment")
  if (anyComment.length) await logExec(a.id, "any_comment_declined", { ...ref, campaignId: anyComment[0].id, detail: `${r.category}, ${r.sentiment}, ${r.risk} risk` })

  if (unsafe || r.needsHuman) {
    await setStatus(comment.id, "needs_human")
    await logExec(a.id, "routed_needs_human", ref)
    return []
  }
  if (settings.replyMode === "manual" || !r.reply) {
    await setStatus(comment.id, "new")
    return []
  }
  if (settings.replyMode === "approve") {
    await setStatus(comment.id, "awaiting_approval")
    await logExec(a.id, "routed_approval", ref)
    return []
  }

  /* Automatic mode: only allowed categories, only calm comments, only under the hourly cap. */
  const { rows } = await metaDb().query(
    `SELECT COUNT(*)::int AS n FROM meta.response_queue WHERE account_id = $1 AND source = 'ai_auto' AND created_at > NOW() - INTERVAL '1 hour'`,
    [a.id]
  )
  const capped = rows[0].n >= settings.autoReplyHourlyCap
  const eligible = settings.autoCategories.includes(r.category) && r.risk === "low" && r.sentiment !== "negative" && !capped
  if (!eligible) {
    await setStatus(comment.id, "awaiting_approval", { note: capped ? "Hourly automatic-reply limit reached." : undefined })
    await logExec(a.id, "routed_approval", { ...ref, detail: capped ? "hourly cap" : `${r.category} not automatic` })
    return []
  }
  const id = await enqueue(a, "reply", "ai_auto", comment.comment_id, { commentRowId: comment.id, text: r.reply, createdBy: "ai" })
  await setStatus(comment.id, "replied", { handledBy: "ai" })
  return id ? [id] : []
}

/* ── Inbox actions (OPS) ───────────────────────────────────────────────────────────────────── */

async function commentRow(id: string): Promise<CommentRow> {
  const { rows } = await metaDb().query(`SELECT * FROM meta.comments WHERE id = $1`, [id])
  if (!rows[0]) throw new IgError("That comment is no longer in the inbox.", 404)
  return rows[0]
}

/** A reply written (or approved) by a person — public, or as the comment's one private DM. */
export async function sendFromInbox(input: { commentRowId: string; text: string; kind: "reply" | "dm"; approvedDraft: boolean; opsUserId: string }) {
  const comment = await commentRow(input.commentRowId)
  const a = await account(comment.account_id)
  const text = String(input.text ?? "").trim()
  if (!text) throw new IgError("Write the reply first.")
  if (input.kind === "reply" && text.length > 300) throw new IgError("Keep public replies under 300 characters.")
  if (input.kind === "dm" && text.length > 900) throw new IgError("Keep the DM under 900 characters.")
  if (input.kind === "dm" && Date.now() - new Date(comment.commented_at).getTime() > SEVEN_DAYS_MS - 60_000)
    throw new IgError("This comment is more than 7 days old — Instagram no longer allows a DM in reply to it.")

  const id = await enqueue(a, input.kind, input.approvedDraft ? "ai_approved" : "manual", comment.comment_id, {
    commentRowId: comment.id,
    text,
    createdBy: input.opsUserId,
  })
  if (!id) throw new IgError(input.kind === "dm" ? "This comment already has its one DM." : "This comment already has a public reply from us.")
  await setStatus(comment.id, "replied", { handledBy: input.opsUserId })
  return id
}

export async function dismissComment(commentRowId: string, opsUserId: string) {
  const c = await commentRow(commentRowId)
  await setStatus(commentRowId, "dismissed", { handledBy: opsUserId })
  await logExec(c.account_id, "dismissed", { commentRowId })
}

export async function hideFromInbox(commentRowId: string, opsUserId: string): Promise<string | null> {
  const comment = await commentRow(commentRowId)
  const a = await account(comment.account_id)
  const id = await enqueue(a, "hide", "moderation", comment.comment_id, { commentRowId: comment.id, createdBy: opsUserId })
  await setStatus(comment.id, "hidden", { handledBy: opsUserId })
  return id
}

/** Runs (or re-runs) the AI on one comment and stores the reading, without sending anything. */
export async function redraft(commentRowId: string) {
  const comment = await commentRow(commentRowId)
  const a = await account(comment.account_id)
  const ctx = await mediaContext(a, comment.media_id)
  const reading = await readComment({
    settings: mergeSettings(a.settings),
    comment: comment.text,
    commenter: comment.commenter_username,
    caption: ctx.caption,
    postNote: ctx.note,
    isReplyToAnother: Boolean(comment.parent_id),
    intents: [],
    draft: true,
  }).catch((error) => {
    throw new IgError(`AI could not draft: ${error instanceof Error ? error.message : error}`)
  })
  await metaDb().query(
    `UPDATE meta.comments
        SET ai_status = 'done', ai_category = $2, ai_sentiment = $3, ai_risk = $4, ai_language = $5, ai_needs_human = $6,
            ai_reason = $7, ai_draft = $8, ai_model = $9, ai_at = NOW(),
            status = CASE WHEN status = 'new' THEN 'awaiting_approval' ELSE status END,
            note = CASE WHEN note LIKE 'AI reading failed:%' OR note LIKE 'Daily AI limit%' THEN NULL ELSE note END
      WHERE id = $1`,
    [comment.id, reading.category, reading.sentiment, reading.risk, reading.language, reading.needsHuman, reading.reason, reading.reply, reading.model]
  )
  await logExec(a.id, "ai_redraft", { commentRowId: comment.id })
  return reading
}

/**
 * Comments the AI could not read — the key was wrong, Claude was down, the daily limit ran out —
 * go through the full reading again, campaigns included, as if they had just arrived. One comment,
 * or every open one on the account. The first 20 are read now; the minute sweep takes the rest.
 */
export async function rereadFailed(accountId: string, commentRowId?: string): Promise<{ count: number; queue: string[] }> {
  const { rows } = await metaDb().query(
    `UPDATE meta.comments
        SET ai_status = 'pending', ai_attempts = 0,
            note = CASE WHEN note LIKE 'AI reading failed:%' OR note LIKE 'Daily AI limit%' THEN NULL ELSE note END
      WHERE account_id = $1 AND ai_status IN ('failed', 'skipped')
        AND status IN ('new', 'needs_human', 'awaiting_approval')
        AND ($2::uuid IS NULL OR id = $2::uuid)
      RETURNING id`,
    [accountId, commentRowId ?? null]
  )
  const queue: string[] = []
  for (const row of rows.slice(0, 20)) {
    try {
      queue.push(...(await triageComment(row.id)))
    } catch (error) {
      console.error(`[meta] reread ${row.id}: ${error instanceof Error ? error.message : error}`)
    }
  }
  if (rows.length) await logExec(accountId, "ai_reread", { detail: `${rows.length} comment(s)` })
  return { count: rows.length, queue }
}

/** The settings screen's "try a comment" box: what would happen, nothing stored or sent. */
export async function testReading(accountId: string, text: string, mediaId?: string) {
  const a = await account(accountId)
  const ctx = await mediaContext(a, mediaId || null)
  const intents = await offerCampaigns(a.id, mediaId || null)
  const reading = await readComment({
    settings: mergeSettings(a.settings),
    comment: String(text ?? "").slice(0, 2000),
    commenter: "test_user",
    caption: ctx.caption,
    postNote: ctx.note,
    isReplyToAnother: false,
    intents: intents.map((c) => ({ id: c.id, description: describeOffer(c) })),
    draft: true,
  })
  const keywordHit = (await liveCampaigns(a.id, "keyword", mediaId || null)).find((c) => matchKeyword(text, c.keywords, c.match_mode))
  return {
    reading,
    keywordCampaign: keywordHit?.name ?? null,
    intentCampaign: intents.find((c) => c.id === reading.intentCampaignId)?.name ?? null,
  }
}

/* ── Conversations (OPS) ───────────────────────────────────────────────────────────────────── */

/** A message in a DM thread — only while Meta's 24-hour window since their last message is open. */
export async function sendInConversation(conversationId: string, text: string, opsUserId: string): Promise<string> {
  const { rows } = await metaDb().query(
    `SELECT *, (last_inbound_at > NOW() - INTERVAL '24 hours') AS window_open FROM meta.conversations WHERE id = $1`,
    [conversationId]
  )
  const conv = rows[0]
  if (!conv) throw new IgError("That conversation no longer exists.", 404)
  if (!conv.window_open)
    throw new IgError("Instagram only allows a reply within 24 hours of the person's last message. Wait for them to write again.")
  const body = String(text ?? "").trim()
  if (!body || body.length > 1000) throw new IgError("Write a message of up to 1,000 characters.")
  const a = await account(conv.account_id)
  const id = await enqueue(a, "message", "manual", conv.participant_id, { conversationId, text: body, createdBy: opsUserId })
  return id!
}

export async function markConversationRead(conversationId: string) {
  await metaDb().query(`UPDATE meta.conversations SET unread = 0 WHERE id = $1`, [conversationId])
}

/* ── Sending ───────────────────────────────────────────────────────────────────────────────── */

/** Sends one queued item. Claims it first, so the immediate attempt and the sweep never both send. */
export async function sendQueue(queueId: string): Promise<void> {
  const { rows } = await metaDb().query(
    `UPDATE meta.response_queue SET status = 'sending', claimed_at = NOW(), attempts = attempts + 1
      WHERE id = $1 AND status = 'pending' AND next_attempt_at <= NOW() RETURNING *`,
    [queueId]
  )
  const q = rows[0]
  if (!q) return
  const ref = { campaignId: q.campaign_id, commentRowId: q.comment_row_id, queueId }

  const finish = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields)
    return metaDb().query(`UPDATE meta.response_queue SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [
      queueId,
      ...keys.map((k) => fields[k]),
    ])
  }

  let comment: CommentRow | null = null
  if (q.comment_row_id) {
    const { rows: cr } = await metaDb().query(`SELECT * FROM meta.comments WHERE id = $1`, [q.comment_row_id])
    comment = cr[0] ?? null
  }
  if (q.kind === "dm" && comment && Date.now() - new Date(comment.commented_at).getTime() > SEVEN_DAYS_MS - 60_000) {
    await finish({ status: "failed", error: "More than 7 days after the comment — Instagram no longer allows a DM." })
    await logExec(q.account_id, "send_failed", { ...ref, detail: "7-day window closed" })
    return
  }

  let a: AccountRow
  let page: { pageId: string; token: string } | null = null
  try {
    a = await account(q.account_id)
    if (a.status !== "active") throw new IgError(`@${a.username} is ${a.status}. Reconnect it in Instagram settings.`)
    if (q.kind === "dm" || q.kind === "message") {
      page = await pageOf(a)
      if (!page) throw new IgError("No Facebook Page is linked, so DMs cannot be sent. Reconnect with the Page assigned to the system user.")
    }
  } catch (error) {
    /* Not final: once the account is fixed, the queue carries on (DMs until their 7 days run out). */
    await finish({
      status: "pending",
      error: error instanceof Error ? error.message : String(error),
      next_attempt_at: new Date(Date.now() + 30 * 60_000),
      attempts: Math.max(0, q.attempts - 1),
    })
    return
  }

  try {
    let external: string | null = null
    if (q.kind === "dm") {
      external = (await sendPrivateReply(page!.pageId, page!.token, q.target_id, q.text)).message_id ?? null
    } else if (q.kind === "message") {
      external = (await sendMessage(page!.pageId, page!.token, q.target_id, q.text)).message_id ?? null
    } else if (q.kind === "reply") {
      external = (await replyToComment(q.target_id, await commentToken(a), q.text)).id ?? null
    } else {
      await hideComment(q.target_id, await commentToken(a), true)
    }
    await finish({ status: "sent", error: null, sent_at: new Date(), external_id: external })
    await logExec(a.id, `sent_${q.kind}`, ref)

    /* DMs become part of the person's conversation history. */
    if (q.kind === "dm" || q.kind === "message") {
      const conversationId =
        q.conversation_id ??
        (await upsertConversation(a.id, comment!.commenter_id, comment!.commenter_username, "out", new Date()))
      if (q.kind === "message") {
        await metaDb().query(`UPDATE meta.conversations SET last_outbound_at = NOW(), last_message_at = NOW() WHERE id = $1`, [conversationId])
      }
      await metaDb().query(
        `INSERT INTO meta.messages (account_id, conversation_id, direction, external_id, text, source, comment_row_id)
         VALUES ($1, $2, 'out', $3, $4, $5, $6)
         ON CONFLICT (account_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
        [a.id, conversationId, external, q.text, q.source === "moderation" ? "manual" : q.source, q.comment_row_id]
      )
    }
  } catch (error) {
    const e = error instanceof IgApiError ? error : null
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    if (e?.tokenInvalid) {
      await markTokenDead(a.id, message)
      await finish({ status: "pending", error: message, next_attempt_at: new Date(Date.now() + 30 * 60_000) })
    } else if (e?.retryable && q.attempts < MAX_SEND_ATTEMPTS) {
      await finish({ status: "pending", error: message, next_attempt_at: new Date(Date.now() + 2 ** q.attempts * 60_000) })
      await logExec(a.id, "send_retry", { ...ref, detail: message })
    } else {
      const final = e?.permissionMissing ? `${message} — the token is missing a permission for this.` : message
      await finish({ status: "failed", error: final })
      await logExec(a.id, "send_failed", { ...ref, detail: final })
    }
  }
}

export async function retryQueue(id: string): Promise<void> {
  const { rowCount } = await metaDb().query(
    `UPDATE meta.response_queue SET status = 'pending', error = NULL, attempts = 0, next_attempt_at = NOW() WHERE id = $1 AND status = 'failed'`,
    [id]
  )
  if (!rowCount) throw new IgError("Only a failed item can be retried.")
}

/** Runs the follow-up work of one webhook: AI readings first, then everything queued. */
export async function runIntake(r: IntakeResult): Promise<void> {
  const queue = [...r.queue]
  for (const id of r.triage) {
    try {
      queue.push(...(await triageComment(id)))
    } catch (error) {
      console.error(`[meta] triage ${id}: ${error instanceof Error ? error.message : error}`)
    }
  }
  for (const id of queue) await sendQueue(id)
}

/** The every-minute sweep: interrupted work back in the queue, then a small batch of each. */
export async function drain(): Promise<{ triaged: number; sent: number }> {
  /* Interrupted by a restart. Safe to redo: the queue is unique per comment and kind, and Meta
     refuses a second private reply to one comment. */
  await metaDb().query(`UPDATE meta.response_queue SET status = 'pending' WHERE status = 'sending' AND claimed_at < NOW() - INTERVAL '10 minutes'`)
  await metaDb().query(
    `UPDATE meta.comments SET ai_status = 'pending'
      WHERE ai_status = 'running' AND received_at < NOW() - INTERVAL '10 minutes' AND ai_attempts < ${MAX_AI_ATTEMPTS}`
  )

  const { rows: pendingAi } = await metaDb().query(`SELECT id FROM meta.comments WHERE ai_status = 'pending' ORDER BY received_at LIMIT 10`)
  for (const row of pendingAi) {
    try {
      for (const id of await triageComment(row.id)) await sendQueue(id)
    } catch (error) {
      console.error(`[meta] triage ${row.id}: ${error instanceof Error ? error.message : error}`)
    }
  }
  const { rows } = await metaDb().query(
    `SELECT id FROM meta.response_queue WHERE status = 'pending' AND next_attempt_at <= NOW() ORDER BY next_attempt_at LIMIT 20`
  )
  for (const row of rows) await sendQueue(row.id)
  return { triaged: pendingAi.length, sent: rows.length }
}

/* ── Analytics and retention ───────────────────────────────────────────────────────────────── */

/**
 * Rolls today and yesterday (IST) into meta.analytics_daily — one row per account and day, and one
 * per campaign and day. Recomputed from the detail tables each time, so running it twice is the same
 * as running it once, and the history outlives the detail rows the purge deletes.
 */
export async function rollupAnalytics(): Promise<void> {
  /* A subquery, because a cast cannot sit directly on a set-returning function in FROM. */
  const days = `(SELECT generate_series((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '1 day')::date AS day)`
  const ist = (col: string) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`

  await metaDb().query(
    `INSERT INTO meta.analytics_daily
       (account_id, campaign_id, day, comments, matched, dms_sent, replies_sent, auto_replies, messages_in, failed, ai_reads, updated_at)
     SELECT a.id, '${NIL_UUID}'::uuid, d.day,
       (SELECT COUNT(*) FROM meta.comments m WHERE m.account_id = a.id AND ${ist("m.received_at")} = d.day),
       (SELECT COUNT(*) FROM meta.comments m WHERE m.account_id = a.id AND m.campaign_id IS NOT NULL AND ${ist("m.received_at")} = d.day),
       (SELECT COUNT(*) FROM meta.response_queue q WHERE q.account_id = a.id AND q.kind = 'dm' AND q.status = 'sent' AND ${ist("q.sent_at")} = d.day),
       (SELECT COUNT(*) FROM meta.response_queue q WHERE q.account_id = a.id AND q.kind = 'reply' AND q.status = 'sent' AND ${ist("q.sent_at")} = d.day),
       (SELECT COUNT(*) FROM meta.response_queue q WHERE q.account_id = a.id AND q.source = 'ai_auto' AND q.status = 'sent' AND ${ist("q.sent_at")} = d.day),
       (SELECT COUNT(*) FROM meta.messages g WHERE g.account_id = a.id AND g.direction = 'in' AND ${ist("g.sent_at")} = d.day),
       (SELECT COUNT(*) FROM meta.response_queue q WHERE q.account_id = a.id AND q.status = 'failed' AND ${ist("q.created_at")} = d.day),
       (SELECT COUNT(*) FROM meta.comments m WHERE m.account_id = a.id AND ${ist("m.ai_at")} = d.day),
       NOW()
     FROM meta.accounts a CROSS JOIN ${days} AS d
     WHERE a.platform = 'instagram'
     ON CONFLICT (account_id, campaign_id, day) DO UPDATE SET
       comments = EXCLUDED.comments, matched = EXCLUDED.matched, dms_sent = EXCLUDED.dms_sent, replies_sent = EXCLUDED.replies_sent,
       auto_replies = EXCLUDED.auto_replies, messages_in = EXCLUDED.messages_in, failed = EXCLUDED.failed, ai_reads = EXCLUDED.ai_reads,
       updated_at = NOW()`
  )

  await metaDb().query(
    `INSERT INTO meta.analytics_daily (account_id, campaign_id, day, matched, dms_sent, replies_sent, failed, updated_at)
     SELECT c.account_id, c.id, d.day,
       (SELECT COUNT(*) FROM meta.comments m WHERE m.campaign_id = c.id AND ${ist("m.received_at")} = d.day),
       (SELECT COUNT(*) FROM meta.response_queue q WHERE q.campaign_id = c.id AND q.kind = 'dm' AND q.status = 'sent' AND ${ist("q.sent_at")} = d.day),
       (SELECT COUNT(*) FROM meta.response_queue q WHERE q.campaign_id = c.id AND q.kind = 'reply' AND q.status = 'sent' AND ${ist("q.sent_at")} = d.day),
       (SELECT COUNT(*) FROM meta.response_queue q WHERE q.campaign_id = c.id AND q.status = 'failed' AND ${ist("q.created_at")} = d.day),
       NOW()
     FROM meta.campaigns c CROSS JOIN ${days} AS d
     WHERE c.status <> 'archived'
     ON CONFLICT (account_id, campaign_id, day) DO UPDATE SET
       matched = EXCLUDED.matched, dms_sent = EXCLUDED.dms_sent, replies_sent = EXCLUDED.replies_sent, failed = EXCLUDED.failed,
       updated_at = NOW()`
  )
}

/**
 * Kept only as long as useful: raw deliveries 14 days, execution logs 90, the inbox, its sends and
 * DM history 180. analytics_daily is kept: it holds counts, not people.
 */
export async function purgeOld(): Promise<void> {
  await metaDb().query(`DELETE FROM meta.webhook_events WHERE received_at < NOW() - INTERVAL '14 days'`)
  await metaDb().query(`DELETE FROM meta.execution_logs WHERE created_at < NOW() - INTERVAL '90 days'`)
  await metaDb().query(`DELETE FROM meta.comments WHERE received_at < NOW() - INTERVAL '180 days'`)
  await metaDb().query(`DELETE FROM meta.messages WHERE sent_at < NOW() - INTERVAL '180 days'`)
  await metaDb().query(`DELETE FROM meta.response_queue WHERE created_at < NOW() - INTERVAL '180 days'`)
  await metaDb().query(
    `DELETE FROM meta.conversations c WHERE last_message_at < NOW() - INTERVAL '180 days'
       AND NOT EXISTS (SELECT 1 FROM meta.messages m WHERE m.conversation_id = c.id)`
  )
}
