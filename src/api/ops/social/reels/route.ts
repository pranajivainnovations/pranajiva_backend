import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { closeReel, createReel, ReelError } from "../../../../services/ai-video/reel-service"
import type { AspectRatio, Resolution } from "../../../../services/ai-video/omni-provider"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/social/reels — create a reel, or close one.
 *
 * Writes only. The Social screens read `social.reels` and `social.reel_shots` from the database
 * directly, like every other OPS screen; what lives behind the service key is the rules — that a
 * reel cannot be framed in a shape the model refuses, and that closing one is deliberate.
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
    title?: string
    brand?: string
    aspectRatio?: string
    resolution?: string
    targetSeconds?: number
    status?: string
  }

  try {
    switch (body.action) {
      case "create": {
        const opsUserId = String(body.opsUserId ?? "")
        if (!/^[0-9a-f-]{36}$/i.test(opsUserId)) {
          res.status(400).json({ error: "opsUserId is required — every reel is attributed." })
          return
        }

        const brand = String(body.brand ?? "pranajiva")
        if (brand !== "pranajiva" && brand !== "crossfriend") {
          res.status(400).json({ error: "brand must be pranajiva or crossfriend." })
          return
        }

        /* Checked here as well as by the CHECK constraints, so a bad value is a sentence rather
           than a Postgres violation surfacing in an OPS error page. */
        const aspectRatio = String(body.aspectRatio ?? "9:16")
        if (aspectRatio !== "9:16" && aspectRatio !== "16:9") {
          res.status(400).json({ error: "The model generates 9:16 or 16:9 only." })
          return
        }

        const resolution = String(body.resolution ?? "720p")
        if (!["360p", "720p", "1080p", "4k"].includes(resolution)) {
          res.status(400).json({ error: "resolution must be 360p, 720p, 1080p or 4k." })
          return
        }

        const targetSeconds = Number(body.targetSeconds ?? 25)
        if (!Number.isInteger(targetSeconds) || targetSeconds < 3 || targetSeconds > 40) {
          res.status(400).json({
            error: "A chained clip runs between 3 and 40 seconds — 40 is the model's ceiling, not ours.",
          })
          return
        }

        const reel = await createReel({
          title: String(body.title ?? ""),
          brand,
          aspectRatio: aspectRatio as AspectRatio,
          resolution: resolution as Resolution,
          targetSeconds,
          opsUserId,
        })

        res.status(200).json(reel)
        return
      }

      case "close": {
        const reelId = String(body.reelId ?? "")
        if (!/^[0-9a-f-]{36}$/i.test(reelId)) {
          res.status(400).json({ error: "reelId is required." })
          return
        }
        const status = body.status === "abandoned" ? "abandoned" : "done"
        await closeReel(reelId, status)
        res.status(200).json({ ok: true, status })
        return
      }

      default:
        res.status(400).json({ error: "action must be create or close." })
    }
  } catch (error) {
    if (error instanceof ReelError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[ops/social/reels] ${detail}`)
    res.status(500).json({ error: "That did not work. The backend log has the detail." })
  }
}
