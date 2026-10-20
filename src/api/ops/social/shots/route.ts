import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { abandonShot, ReelError, staleRenders, startShot } from "../../../../services/ai-video/reel-service"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/social/shots — generate the next shot in a reel, or clear an orphaned render.
 *
 * ── Why this returns before the video exists ──────────────────────────────────────────────────
 * Generation takes minutes and the API holds its connection open for the whole of it — there is no
 * operation id to poll. So this records the shot as `rendering`, starts the work in the background
 * and answers immediately. The screen then watches the row, which is the only thing that is true
 * for every viewer rather than just the one who pressed the button.
 *
 * ── Why there is no "regenerate" action ───────────────────────────────────────────────────────
 * Deliberately. Every call costs ten cents a second against the operator's own card, and a button
 * that quietly replaces a shot would make a double-click indistinguishable from an intention. A
 * failed shot is cleared and the next one generated, which is two acts because it is two
 * decisions.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    action?: string
    opsUserId?: string
    reelId?: string
    shotId?: string
    prompt?: string
    mode?: string
    firstImageKey?: string
    lastImageKey?: string
  }

  try {
    switch (body.action) {
      case "generate": {
        const opsUserId = String(body.opsUserId ?? "")
        if (!/^[0-9a-f-]{36}$/i.test(opsUserId)) {
          res.status(400).json({ error: "opsUserId is required — a render is billed to a person's key." })
          return
        }

        const reelId = String(body.reelId ?? "")
        if (!/^[0-9a-f-]{36}$/i.test(reelId)) {
          res.status(400).json({ error: "reelId is required." })
          return
        }

        const mode = String(body.mode ?? "")
        if (!["text", "image", "first_last", "continue"].includes(mode)) {
          res.status(400).json({ error: "mode must be text, image, first_last or continue." })
          return
        }

        /**
         * The mode and the images have to agree.
         *
         * Checked here rather than left to the provider, because the provider's refusal arrives
         * after the request and this one arrives instead of it. `first_last` without two images
         * would otherwise render a perfectly good clip that interpolated to nothing in particular,
         * and the operator would pay for it before noticing.
         */
        if (mode === "first_last" && !(body.firstImageKey && body.lastImageKey)) {
          res.status(400).json({
            error: "A first-and-last shot needs both frames. Upload the closing frame, or use a single anchor.",
          })
          return
        }
        if (mode === "image" && !body.firstImageKey) {
          res.status(400).json({ error: "An anchored shot needs its opening frame." })
          return
        }
        if (mode === "continue" && (body.firstImageKey || body.lastImageKey)) {
          res.status(400).json({
            error: "A continuation carries on from the previous shot's last frame, so it takes no images.",
          })
          return
        }

        const started = await startShot({
          reelId,
          prompt: String(body.prompt ?? ""),
          mode: mode as "text" | "image" | "first_last" | "continue",
          firstImageKey: body.firstImageKey ?? null,
          lastImageKey: body.lastImageKey ?? null,
          opsUserId,
        })

        res.status(200).json({ ...started, status: "rendering" })
        return
      }

      case "stale":
        res.status(200).json({ stale: await staleRenders() })
        return

      case "abandon": {
        const shotId = String(body.shotId ?? "")
        if (!/^[0-9a-f-]{36}$/i.test(shotId)) {
          res.status(400).json({ error: "shotId is required." })
          return
        }
        await abandonShot(shotId)
        res.status(200).json({ ok: true })
        return
      }

      default:
        res.status(400).json({ error: "action must be generate, stale or abandon." })
    }
  } catch (error) {
    if (error instanceof ReelError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[ops/social/shots] ${detail}`)
    res.status(500).json({ error: "That did not work. The backend log has the detail." })
  }
}
