import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { putAnchorImage } from "../../../../services/ai-video/store"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/social/anchors — store an anchor frame for a shot.
 *
 * ── Why the image is stored before it is used ─────────────────────────────────────────────────
 * A shot sends its anchor to Google on every attempt, and an attempt can happen weeks after the
 * image was chosen. Keeping the frame means a shot can be regenerated against the SAME reference
 * instead of whatever the operator still has in their downloads folder — which is the difference
 * between "use the reference image" being an instruction and being a hope.
 *
 * ── Why base64 and not multipart ──────────────────────────────────────────────────────────────
 * The upload arrives from an OPS server action that has already read the file, so the bytes are in
 * hand and multipart would mean re-encoding them to parse them again. The ai-studio uploads route
 * uses multer because its caller is a browser posting a form; this one's caller is a server.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as { reelId?: string; data?: string; mimeType?: string }

  const reelId = String(body.reelId ?? "")
  if (!/^[0-9a-f-]{36}$/i.test(reelId)) {
    res.status(400).json({ error: "reelId is required — anchors are stored with their reel." })
    return
  }

  const mimeType = String(body.mimeType ?? "")
  /* The three the model accepts. A refusal here beats one from Google after the upload. */
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    res.status(400).json({ error: "An anchor frame must be a JPEG, PNG or WebP." })
    return
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(String(body.data ?? ""), "base64")
  } catch {
    res.status(400).json({ error: "The image data could not be decoded." })
    return
  }

  if (!bytes.length) {
    res.status(400).json({ error: "The image was empty." })
    return
  }

  /* 12MB. Comfortably above any frame worth anchoring to and well below the point where holding it
     in memory to base64 it becomes a problem. */
  if (bytes.length > 12 * 1024 * 1024) {
    res.status(413).json({ error: "That image is over 12MB. Export it smaller — a frame does not need more." })
    return
  }

  try {
    res.status(200).json(await putAnchorImage(reelId, bytes, mimeType))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[ops/social/anchors] ${detail}`)
    res.status(500).json({ error: "The image could not be stored." })
  }
}
