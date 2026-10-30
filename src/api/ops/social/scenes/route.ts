import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  addScene,
  chooseTake,
  deleteScene,
  moveScene,
  renderTake,
  updateScene,
} from "../../../../services/ai-video/scene-service"
import { ReelError } from "../../../../services/ai-video/reel-service"
import { previewScenePrompt } from "../../../../services/ai-video/compose-prompt"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/social/scenes — plan a storyboard, and render takes of it.
 *
 * ── Why planning and rendering share a route ─────────────────────────────────────────────────
 * They are the same object at two moments. A scene is edited a dozen times for free and rendered
 * once for money, and keeping both here means the rules about what a scene may be — that it cannot
 * continue something that comes after it, that it cannot carry both references and a continuation
 * — are stated once rather than in two places that eventually disagree.
 *
 * `preview` is the odd one out and earns its place: it returns the exact text a render would send,
 * composed by the same function, so an operator can read what fifty cents is about to buy.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  const action = String(body.action ?? "")
  const uuid = (value: unknown) => (/^[0-9a-f-]{36}$/i.test(String(value)) ? String(value) : null)

  try {
    switch (action) {
      case "add": {
        const reelId = uuid(body.reelId)
        if (!reelId) {
          res.status(400).json({ error: "reelId is required." })
          return
        }
        res.status(200).json(await addScene(reelId))
        return
      }

      case "update": {
        const sceneId = uuid(body.sceneId)
        if (!sceneId) {
          res.status(400).json({ error: "sceneId is required." })
          return
        }

        const images = Array.isArray(body.imageKeys) ? (body.imageKeys as unknown[]).map(String) : []
        if (images.length > 6) {
          res.status(400).json({
            error: "Six reference images is the model's limit — they are addressed as IMAGE_REF_0 to IMAGE_REF_5.",
          })
          return
        }

        await updateScene(sceneId, {
          prompt: String(body.prompt ?? ""),
          shotType: String(body.shotType ?? ""),
          cameraMove: String(body.cameraMove ?? ""),
          audioNote: String(body.audioNote ?? ""),
          avoid: String(body.avoid ?? ""),
          targetSeconds: Number(body.targetSeconds ?? 5),
          continuesFrom: uuid(body.continuesFrom),
          imageKeys: images,
        })
        res.status(200).json({ ok: true })
        return
      }

      case "preview": {
        /* Pure composition — touches nothing, costs nothing, and is the same code a render uses. */
        res.status(200).json({
          prompt: previewScenePrompt({
            prompt: String(body.prompt ?? ""),
            shotType: String(body.shotType ?? ""),
            cameraMove: String(body.cameraMove ?? ""),
            audioNote: String(body.audioNote ?? ""),
            avoid: String(body.avoid ?? ""),
            targetSeconds: Number(body.targetSeconds ?? 5),
            imageCount: Array.isArray(body.imageKeys) ? body.imageKeys.length : 0,
            isContinuation: Boolean(body.continuesFrom),
          }),
        })
        return
      }

      case "delete": {
        const sceneId = uuid(body.sceneId)
        if (!sceneId) {
          res.status(400).json({ error: "sceneId is required." })
          return
        }
        await deleteScene(sceneId)
        res.status(200).json({ ok: true })
        return
      }

      case "move": {
        const sceneId = uuid(body.sceneId)
        const direction = body.direction === "up" ? "up" : "down"
        if (!sceneId) {
          res.status(400).json({ error: "sceneId is required." })
          return
        }
        await moveScene(sceneId, direction)
        res.status(200).json({ ok: true })
        return
      }

      case "render": {
        const sceneId = uuid(body.sceneId)
        const opsUserId = uuid(body.opsUserId)
        if (!sceneId || !opsUserId) {
          res.status(400).json({ error: "sceneId and opsUserId are required — a render is billed to a person." })
          return
        }
        res.status(200).json({ ...(await renderTake({ sceneId, opsUserId })), status: "rendering" })
        return
      }

      case "choose": {
        const sceneId = uuid(body.sceneId)
        if (!sceneId) {
          res.status(400).json({ error: "sceneId is required." })
          return
        }
        /* A null take is allowed: unpicking is how an operator says none of these is good yet. */
        await chooseTake(sceneId, uuid(body.takeId))
        res.status(200).json({ ok: true })
        return
      }

      default:
        res.status(400).json({ error: "action must be add, update, preview, delete, move, render or choose." })
    }
  } catch (error) {
    if (error instanceof ReelError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[ops/social/scenes] ${detail}`)
    res.status(500).json({ error: "That did not work. The backend log has the detail." })
  }
}
