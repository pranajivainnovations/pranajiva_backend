import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { runSingleFileUpload } from "../../../../services/ai-image/multer-runner"
import { validateUpload } from "../../../../services/ai-image/upload-validation"
import { storeReferenceUpload } from "../../../../services/ai-image/personal-uploads-s3"
import { getAiStudioDbPool } from "../../../../services/ai-image/db"
import crypto from "crypto"

const ALLOWED_PURPOSES = ["theme_reference", "recreate_cake", "photo_cake"] as const
type Purpose = (typeof ALLOWED_PURPOSES)[number]

/**
 * POST /store/ai-studio/uploads
 *
 * Uploads a customer's personal reference image — theme inspiration,
 * "recreate this cake," or a photo-cake source photo. Stored privately,
 * scoped to the customer (not a generation, which may not exist yet), and
 * NOT looked at by any AI/vision step here — this route only validates and
 * stores. Understanding what's in the image happens later, only when a
 * specific generation actually uses it.
 *
 * Request: multipart/form-data
 *   file: the image (JPEG/PNG/WEBP, max 8MB)
 *   purpose: "theme_reference" | "recreate_cake" | "photo_cake"
 *
 * Response 200: { success: true, uploadId: string }
 * Response 400: invalid file or purpose
 * Response 401: not authenticated
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.user?.customer_id

  if (!customerId) {
    return res.status(401).json({
      success: false,
      error: "Authentication required. Please log in to upload an image.",
      code: "AUTH_REQUIRED",
    })
  }

  try {
    await runSingleFileUpload(req, res, "file")
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Upload failed.",
      code: "UPLOAD_ERROR",
    })
  }

  const file = (req as any).file as Express.Multer.File | undefined
  const purpose = (req.body as { purpose?: string })?.purpose

  if (!file) {
    return res.status(400).json({ success: false, error: "No file uploaded.", code: "INVALID_REQUEST" })
  }

  if (!purpose || !ALLOWED_PURPOSES.includes(purpose as Purpose)) {
    return res.status(400).json({
      success: false,
      error: `purpose must be one of: ${ALLOWED_PURPOSES.join(", ")}`,
      code: "INVALID_REQUEST",
    })
  }

  const validation = validateUpload(file.buffer)
  if (!validation.ok || !validation.image) {
    return res.status(400).json({ success: false, error: validation.error, code: "INVALID_FILE" })
  }

  try {
    // storeReferenceUpload's own uploadId is only used to build the S3 key —
    // callers reference the personal_uploads row id instead, below.
    const { s3Key } = await storeReferenceUpload(
      file.buffer,
      customerId,
      validation.image.mimeType,
      validation.image.extension
    )

    const db = getAiStudioDbPool()
    const rowId = crypto.randomUUID()
    await db.query(
      `INSERT INTO ai_studio.personal_uploads
        (id, customer_id, s3_key, original_filename, mime_type, size_bytes, purpose, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploaded', NOW(), NOW())`,
      [rowId, customerId, s3Key, file.originalname || null, validation.image.mimeType, file.buffer.length, purpose]
    )

    return res.status(200).json({ success: true, uploadId: rowId })
  } catch (error) {
    console.error("[API /store/ai-studio/uploads] Error:", error)
    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again.",
      code: "INTERNAL_ERROR",
    })
  }
}
