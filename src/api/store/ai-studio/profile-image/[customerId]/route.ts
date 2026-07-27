import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import type { CustomerService } from "@medusajs/medusa"
import { getProfileImageViewUrl } from "../../../../../services/ai-image/personal-uploads-s3"

/**
 * GET /store/ai-studio/profile-image/:customerId
 *
 * Returns a short-lived signed URL for a customer's profile image.
 * Auth: requires the REQUESTER to be logged in as any customer — not
 * necessarily the same customer whose image is being viewed. This is the
 * "visible to other logged-in customers, not the public" access rule
 * decided for profile images (see PROJECT-TRACKER/STATUS.md) — the S3
 * object itself is always private; this route is the only way to view one.
 *
 * Response 200: { success: true, url: string, expiresIn: number }
 * Response 401: requester not authenticated
 * Response 404: target customer has no profile image set
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const requesterId = req.user?.customer_id

  if (!requesterId) {
    return res.status(401).json({
      success: false,
      error: "Authentication required.",
      code: "AUTH_REQUIRED",
    })
  }

  const targetCustomerId = req.params.customerId

  try {
    const customerService: CustomerService = req.scope.resolve("customerService")
    const customer = await customerService.retrieve(targetCustomerId)
    const s3Key = (customer.metadata as Record<string, unknown> | null)?.profile_image_key as string | undefined

    if (!s3Key) {
      return res.status(404).json({ success: false, error: "No profile image set.", code: "NOT_FOUND" })
    }

    const url = await getProfileImageViewUrl(s3Key)
    return res.status(200).json({ success: true, url, expiresIn: 900 })
  } catch (error) {
    console.error("[API /store/ai-studio/profile-image/:customerId] Error:", error)
    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again.",
      code: "INTERNAL_ERROR",
    })
  }
}
