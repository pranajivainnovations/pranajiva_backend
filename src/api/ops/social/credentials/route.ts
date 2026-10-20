import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  deleteCredential,
  getCredentialSummary,
  ReelError,
  saveCredential,
} from "../../../../services/ai-video/reel-service"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/social/credentials — save, read or forget one operator's video API key.
 *
 * ── Why the key goes through the backend at all ───────────────────────────────────────────────
 * OPS reads the database directly for everything it displays, so a screen could in principle write
 * this row itself. It must not. The key has to be encrypted with a secret that only the backend
 * holds, and an OPS instance able to encrypt it would be an OPS instance able to decrypt every
 * operator's key — which is the one thing this design exists to prevent.
 *
 * ── Why reading never returns the key ─────────────────────────────────────────────────────────
 * `action: "get"` answers with the model, the ceiling, what has been spent, and the last four
 * characters. There is deliberately no path, for anyone, that returns the key itself. An operator
 * who has lost theirs gets a new one from Google; a tool that could read it back would be a much
 * more attractive thing to break into than a reel builder deserves to be.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    action?: string
    opsUserId?: string
    apiKey?: string
    model?: string
    monthlyCapCents?: number
  }

  const opsUserId = String(body.opsUserId ?? "")
  if (!/^[0-9a-f-]{36}$/i.test(opsUserId)) {
    res.status(400).json({ error: "opsUserId is required — a key belongs to a person." })
    return
  }

  try {
    switch (body.action) {
      case "get":
        res.status(200).json({ credential: await getCredentialSummary(opsUserId) })
        return

      case "save": {
        const model = String(body.model ?? "").trim() || "gemini-omni-1.1-flash"

        /**
         * The model is checked against a list rather than accepted as typed.
         *
         * Not for safety — the key is the operator's own and they may spend it as they like — but
         * because a typo in a model name comes back as an opaque 404 from Google after the request
         * has already been made, and "gemini-omni-1.1-flsh is not a model" is a far better thing
         * for a person to read than Google's version of it.
         */
        const ALLOWED = [
          "gemini-omni-1.1-flash",
          /* Still accepted for anyone who has a reason to pin them, and plainly labelled as
             shutting down on the screen rather than silently refused here. */
          "veo-3.1-generate-preview",
          "veo-3.1-fast-generate-preview",
        ]
        if (!ALLOWED.includes(model)) {
          res.status(400).json({ error: `${model} is not a model this tool knows how to call.` })
          return
        }

        const cap = Number(body.monthlyCapCents)
        if (!Number.isInteger(cap) || cap < 100 || cap > 100000) {
          res.status(400).json({ error: "The monthly ceiling must be between $1 and $1,000." })
          return
        }

        await saveCredential({
          opsUserId,
          apiKey: String(body.apiKey ?? ""),
          model,
          monthlyCapCents: cap,
        })
        res.status(200).json({ credential: await getCredentialSummary(opsUserId) })
        return
      }

      case "forget":
        await deleteCredential(opsUserId)
        res.status(200).json({ credential: null })
        return

      default:
        res.status(400).json({ error: "action must be get, save or forget." })
    }
  } catch (error) {
    if (error instanceof ReelError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[ops/social/credentials] ${detail}`)
    /* The message is passed through: the one failure an operator will actually hit here is the
       backend having no secret to derive the encryption key from, and that is theirs to fix. */
    res.status(500).json({ error: detail })
  }
}
