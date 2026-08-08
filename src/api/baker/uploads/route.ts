import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../services/baker-portal/guard"
import {
  createBakerUploadSignature,
  MAX_UPLOAD_BYTES,
  type BakerUploadPurpose,
} from "../../../services/baker-portal/uploads"

const PURPOSES: BakerUploadPurpose[] = ["product", "profile", "banner"]

/**
 * POST /baker/uploads
 *
 * Issues a short-lived, policy-constrained upload straight to S3.
 *
 * Body: { purpose: "product" | "profile" | "banner", contentType, sizeBytes }
 * 200:  { url, fields, publicUrl, key, maxBytes, expiresInSeconds }
 *
 * This route hands out permission, not storage — the image itself goes from the portal to S3
 * directly, because this install's JSON body limit is ~100KB and no photo would fit through it.
 *
 * The destination folder is derived from the SESSION's bakerId and pinned inside the signed policy.
 * A baker cannot aim an upload at another bakery's folder: the request body has no say in the key,
 * and S3 refuses anything the signature does not cover.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  try {
    const body = (req.body ?? {}) as {
      purpose?: string
      contentType?: string
      sizeBytes?: number
    }

    const purpose = String(body.purpose ?? "product") as BakerUploadPurpose
    if (!PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "Unknown upload type." })
    }

    const signature = await createBakerUploadSignature(
      ctx.bakerId,
      purpose,
      String(body.contentType ?? ""),
      Number(body.sizeBytes)
    )

    return res.status(200).json(signature)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed."
    // validateUploadRequest throws messages written for a baker to read; anything else is a real
    // fault (missing credentials, S3 unreachable) and must not be echoed back.
    const isValidation = message.startsWith("Photos must") || message.startsWith("That file")
    if (!isValidation) {
      console.error("[API /baker/uploads] Error:", error)
    }
    return res.status(isValidation ? 400 : 500).json({
      error: isValidation ? message : "Couldn't prepare the upload. Please try again.",
      maxBytes: MAX_UPLOAD_BYTES,
    })
  }
}
