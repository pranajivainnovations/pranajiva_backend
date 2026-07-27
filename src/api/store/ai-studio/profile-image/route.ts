import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import type { CustomerService } from "@medusajs/medusa"
import { runSingleFileUpload } from "../../../../services/ai-image/multer-runner"
import { validateUpload } from "../../../../services/ai-image/upload-validation"
import { storeProfileImage } from "../../../../services/ai-image/personal-uploads-s3"

/**
 * POST /store/ai-studio/profile-image
 *
 * Uploads (or replaces) the authenticated customer's profile image. Stored
 * privately in S3 at a fixed per-customer key — a new upload silently
 * overwrites the old one. The pointer lives on the Medusa customer's own
 * `metadata` field (`profile_image_key`) rather than a dedicated table —
 * this isn't an AI Cake Studio concept, just a general account feature that
 * happens to share the same S3 bucket/storage conventions.
 *
 * The image itself stays private forever (never a public ACL) — viewing it
 * (including by the owner) always goes through
 * GET /store/ai-studio/profile-image/:customerId, which mints a short-lived
 * signed URL only for other logged-in customers, never anonymous visitors.
 *
 * Response 200: { success: true }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const customerId = req.user?.customer_id

  if (!customerId) {
    return res.status(401).json({
      success: false,
      error: "Authentication required. Please log in to upload a profile image.",
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
  if (!file) {
    return res.status(400).json({ success: false, error: "No file uploaded.", code: "INVALID_REQUEST" })
  }

  const validation = validateUpload(file.buffer)
  if (!validation.ok || !validation.image) {
    return res.status(400).json({ success: false, error: validation.error, code: "INVALID_FILE" })
  }

  try {
    const { s3Key } = await storeProfileImage(file.buffer, customerId, validation.image.mimeType)

    const customerService: CustomerService = req.scope.resolve("customerService")
    const customer = await customerService.retrieve(customerId)
    await customerService.update(customerId, {
      metadata: { ...(customer.metadata || {}), profile_image_key: s3Key },
    })

    return res.status(200).json({ success: true })
  } catch (error) {
    console.error("[API /store/ai-studio/profile-image] Error:", error)
    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again.",
      code: "INTERNAL_ERROR",
    })
  }
}
