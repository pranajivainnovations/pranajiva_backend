import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  archiveTemplate,
  connectAccount,
  disconnectAccount,
  dismissComment,
  duplicateCampaign,
  getSettings,
  hideFromInbox,
  IgError,
  markConversationRead,
  redraft,
  retryQueue,
  saveCampaign,
  saveMediaNote,
  saveSettings,
  saveTemplate,
  sendFromInbox,
  sendInConversation,
  sendQueue,
  setCampaignStatus,
  syncMedia,
  testReading,
} from "../../../services/meta/automation"
import { isMissingSchema } from "../../../services/meta/db"
import { isValidOpsServiceKey, OPS_SERVICE_KEY_HEADER } from "../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/meta — every write the OPS Meta screens make.
 *
 * Through the backend, never straight into the database from OPS: tokens are sealed with a secret
 * only this server holds, and sending has rules (one DM per comment, 7 days, the 24-hour window,
 * caps) that must have exactly one implementation. OPS reads the `meta` tables for display.
 *
 * No action ever returns a token.
 */

const UUID = /^[0-9a-f-]{36}$/i
const WORKSPACE = /^[a-z0-9][a-z0-9-]{1,63}$/

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
  const id = (key: string) => {
    const v = String(body[key] ?? "")
    if (!UUID.test(v)) throw new IgError(`${key} is missing.`)
    return v
  }
  const workspace = () => {
    const w = String(body.workspace ?? "")
    if (!WORKSPACE.test(w)) throw new IgError("workspace is missing.")
    return w
  }
  /* Sent straight away so the person in OPS sees the result on the next refresh, not a minute later. */
  const sendNow = (queueId: string | null) => {
    if (queueId) sendQueue(queueId).catch((e) => console.error(`[ops/meta] send: ${e?.message ?? e}`))
  }

  try {
    switch (body.action) {
      case "connect":
        res.json(
          await connectAccount({
            token: String(body.token ?? ""),
            igUserId: String(body.igUserId ?? ""),
            pageId: body.pageId ? String(body.pageId) : undefined,
            workspace: workspace(),
            opsUserId,
          })
        )
        return
      case "disconnect":
        await disconnectAccount(id("accountId"))
        res.json({ ok: true })
        return
      case "settings_get":
        res.json({ settings: await getSettings(id("accountId")) })
        return
      case "settings_save":
        res.json({ settings: await saveSettings(id("accountId"), body.settings ?? {}) })
        return
      case "media_sync":
        res.json(await syncMedia(id("accountId")))
        return
      case "media_note":
        await saveMediaNote(id("accountId"), String(body.mediaId ?? ""), String(body.note ?? ""))
        res.json({ ok: true })
        return
      case "campaign_save":
        res.json({
          campaign: await saveCampaign({
            ...body,
            accountId: id("accountId"),
            campaignId: body.campaignId ? id("campaignId") : undefined,
            opsUserId,
          }),
        })
        return
      case "campaign_status":
        await setCampaignStatus(id("campaignId"), String(body.status ?? ""))
        res.json({ ok: true })
        return
      case "campaign_duplicate":
        res.json({ campaign: await duplicateCampaign(id("campaignId"), opsUserId) })
        return
      case "template_save":
        res.json({
          template: await saveTemplate({
            id: body.templateId ? id("templateId") : undefined,
            workspace: workspace(),
            name: String(body.name ?? ""),
            channel: String(body.channel ?? "any"),
            body: String(body.body ?? ""),
            opsUserId,
          }),
        })
        return
      case "template_archive":
        await archiveTemplate(id("templateId"), workspace())
        res.json({ ok: true })
        return
      case "inbox_send":
        sendNow(
          await sendFromInbox({
            commentRowId: id("commentId"),
            text: String(body.text ?? ""),
            kind: body.kind === "dm" ? "dm" : "reply",
            approvedDraft: Boolean(body.approvedDraft),
            opsUserId,
          })
        )
        res.json({ ok: true })
        return
      case "inbox_hide":
        sendNow(await hideFromInbox(id("commentId"), opsUserId))
        res.json({ ok: true })
        return
      case "inbox_dismiss":
        await dismissComment(id("commentId"), opsUserId)
        res.json({ ok: true })
        return
      case "inbox_redraft":
        res.json({ reading: await redraft(id("commentId")) })
        return
      case "conversation_send":
        sendNow(await sendInConversation(id("conversationId"), String(body.text ?? ""), opsUserId))
        res.json({ ok: true })
        return
      case "conversation_read":
        await markConversationRead(id("conversationId"))
        res.json({ ok: true })
        return
      case "queue_retry":
        await retryQueue(id("queueId"))
        sendNow(String(body.queueId))
        res.json({ ok: true })
        return
      case "test_reading":
        res.json(await testReading(id("accountId"), String(body.text ?? ""), body.mediaId ? String(body.mediaId) : undefined))
        return
      default:
        res.status(400).json({ error: "Unknown action." })
    }
  } catch (error) {
    if (isMissingSchema(error)) {
      res.status(503).json({ error: "The Meta tables are not installed yet. Apply migration 1729400000000-CreateMetaIntegrations." })
      return
    }
    if (error instanceof IgError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    console.error(`[ops/meta] ${body.action}: ${error instanceof Error ? error.message : error}`)
    res.status(500).json({ error: error instanceof Error ? error.message : "Something went wrong." })
  }
}
