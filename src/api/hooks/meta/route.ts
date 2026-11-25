import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { recordWebhook, runIntake, type IntakeResult } from "../../../services/meta/automation"
import { verifyMetaSignature } from "../../../services/meta/graph"

/**
 * /hooks/meta — the Meta app's single webhook endpoint.
 *
 * Meta App Dashboard → Webhooks → object "Instagram":
 *   Callback URL   https://api.pranajiva.in/hooks/meta
 *   Verify token   IG_WEBHOOK_VERIFY_TOKEN from the server's .env
 *   Fields         comments (required), messages (for the DM history), live_comments (optional)
 * The same URL will take the "Page" and "WhatsApp Business Account" objects when those arrive;
 * today anything that is not object "instagram" is logged and ignored.
 *
 * GET  is Meta checking the URL once, when the webhook is saved.
 * POST is every delivery, signed with the Meta app secret (IG_APP_SECRET).
 */

/** The subscription handshake: echo the challenge back if, and only if, the verify token matches. */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  /* Read from the raw URL: query parsers disagree about keys with dots in them ("hub.mode"). */
  const params = new URL(req.originalUrl || req.url, "http://local").searchParams
  const expected = process.env.IG_WEBHOOK_VERIFY_TOKEN

  if (!expected) {
    console.error("[hooks/meta] IG_WEBHOOK_VERIFY_TOKEN is not set — cannot verify the subscription")
    res.status(503).send("not configured")
    return
  }
  if (params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === expected) {
    res.status(200).type("text/plain").send(params.get("hub.challenge") ?? "")
    return
  }
  res.status(403).send("forbidden")
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const raw = (req as any).rawBody as string | undefined
  const secret = process.env.IG_APP_SECRET

  /**
   * Fail closed. The signature is the only proof a delivery is from Meta, and acting on an unsigned
   * one would let anybody make us message anybody. A missing secret is a fault to fix, not to skip.
   */
  if (!secret) {
    console.error("[hooks/meta] IG_APP_SECRET is not set — refusing every delivery")
    res.status(503).json({ error: "not configured" })
    return
  }
  if (!raw || !verifyMetaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, secret)) {
    console.warn("[hooks/meta] signature did not verify — delivery ignored")
    res.status(401).json({ error: "bad signature" })
    return
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    res.status(200).json({ received: true })
    return
  }

  /* Recorded before answering, so nothing is lost if the process dies; the AI reading and the
     sending happen after answering, so Meta never waits on Claude or on its own API. Anything this
     attempt does not finish, the every-minute job picks up. */
  let work: IntakeResult = { queue: [], triage: [] }
  try {
    work = await recordWebhook(body)
  } catch (error) {
    console.error(`[hooks/meta] could not record delivery: ${error instanceof Error ? error.message : error}`)
  }

  res.status(200).json({ received: true })

  runIntake(work).catch((error) =>
    console.error(`[hooks/meta] follow-up failed: ${error instanceof Error ? error.message : error}`)
  )
}
