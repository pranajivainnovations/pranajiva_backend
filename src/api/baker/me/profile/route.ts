import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { requireBakerUser } from "../../../../services/baker-portal/guard"
import {
  saveBakerImage,
  updateBakerProfile,
  type BakerProfileInput,
} from "../../../../services/baker-portal/profile"

/**
 * PATCH /baker/me/profile
 *
 * Lets a bakery maintain its own details. The baker id comes from the SESSION, so this route can
 * only ever update the caller's own bakery — there is no id in the URL or the body to tamper with.
 *
 * Which fields are writable is decided by the allowlist in services/baker-portal/profile.ts, not by
 * this route and not by the request body. Verification badges, public visibility, featured ranking,
 * status and the URL slug are all absent from it and stay ops-only.
 *
 * Body: any subset of the editable fields, plus optional `image: { purpose, url, s3Key }` to record
 * a photo that has already been uploaded to S3 via POST /baker/uploads.
 */
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const guard = await requireBakerUser(req)
  if (!guard.ctx) {
    return res.status(guard.status).json({ error: guard.error })
  }
  const { ctx } = guard

  try {
    const body = (req.body ?? {}) as Partial<BakerProfileInput> & {
      image?: { purpose?: string; url?: string; s3Key?: string }
    }

    // Read field by field rather than spreading the body — spreading would let any future column
    // name in the allowlist be set from an unvalidated value, and would quietly carry through keys
    // this route has never considered.
    const input: BakerProfileInput = {}
    if (body.name !== undefined) input.name = String(body.name)
    if (body.contactPerson !== undefined) input.contactPerson = String(body.contactPerson)
    if (body.phone !== undefined) input.phone = String(body.phone)
    if (body.whatsappNumber !== undefined) input.whatsappNumber = String(body.whatsappNumber)
    if (body.email !== undefined) input.email = String(body.email)
    if (body.address !== undefined) input.address = String(body.address)
    if (body.bio !== undefined) input.bio = String(body.bio)
    if (body.websiteUrl !== undefined) input.websiteUrl = String(body.websiteUrl)
    if (body.avgTurnaroundHours !== undefined) {
      const n = Number(body.avgTurnaroundHours)
      input.avgTurnaroundHours = Number.isFinite(n) ? n : null
    }
    if (body.specialtyTags !== undefined) {
      input.specialtyTags = (Array.isArray(body.specialtyTags) ? body.specialtyTags : [])
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 12)
    }

    await updateBakerProfile(ctx.bakerId, input)

    if (body.image?.url && body.image?.s3Key) {
      const purpose = body.image.purpose === "banner" ? "banner" : "profile"
      // The URL is only accepted if it points inside THIS baker's own S3 folder. The upload
      // signature already guarantees that, but this route would otherwise take any string —
      // including a link to another bakery's image, or somewhere off our bucket entirely.
      if (!body.image.s3Key.startsWith(`bakers-images/${ctx.bakerId}/`)) {
        return res.status(400).json({ error: "That image doesn't belong to your bakery." })
      }
      await saveBakerImage(ctx.bakerId, purpose, String(body.image.url), String(body.image.s3Key))
    }

    return res.status(200).json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong."
    // validateBakerProfile throws copy written for a baker; anything else is a real fault.
    const isValidation = message.length < 160 && !/[{}]/.test(message) && !message.includes("\n")
    if (!isValidation) {
      console.error("[API /baker/me/profile] Error:", error)
    }
    return res
      .status(isValidation ? 400 : 500)
      .json({ error: isValidation ? message : "Couldn't save your details. Please try again." })
  }
}
