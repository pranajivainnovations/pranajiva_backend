import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { abandonTake } from "../../../../services/ai-video/scene-service"
import { ReelError, staleRenders } from "../../../../services/ai-video/reel-service"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/social/shots — the two things that are about a render rather than a plan.
 *
 * Generating moved to /ops/social/scenes, where it belongs: a render is an attempt at a scene, and
 * the rules it has to satisfy are the scene's rules. What is left here is finding renders that
 * outlived the process that started them, and giving up on one.
 *
 * The path keeps its name rather than being renamed to /takes. It was live for a day and nothing
 * else calls it, so the rename would be free — but a route that moves for tidiness is a route that
 * 404s for anything that cached the old one, and "shots" is still what an operator calls these.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as { action?: string; takeId?: string }

  try {
    switch (body.action) {
      case "stale":
        res.status(200).json({ stale: await staleRenders() })
        return

      case "abandon": {
        const takeId = String(body.takeId ?? "")
        if (!/^[0-9a-f-]{36}$/i.test(takeId)) {
          res.status(400).json({ error: "takeId is required." })
          return
        }
        await abandonTake(takeId)
        res.status(200).json({ ok: true })
        return
      }

      default:
        res.status(400).json({ error: "action must be stale or abandon." })
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
