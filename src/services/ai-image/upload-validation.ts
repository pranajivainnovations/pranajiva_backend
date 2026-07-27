/**
 * Upload Validation
 *
 * Deliberately separate from any AI/feature-level processing of an upload's
 * content — this is upload-time hygiene only (is it actually an image, is it
 * a sane size), not understanding what's *in* the image. That distinction
 * matters: personal uploads should never be looked at by an LLM/vision model
 * until a specific feature actually needs to, but basic file validation has
 * to happen at upload time regardless, so nothing malformed or oversized
 * ever reaches S3 in the first place.
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 // 8MB

export interface ValidatedImage {
  mimeType: string
  extension: string
}

/**
 * Sniffs the actual file signature rather than trusting the client-provided
 * Content-Type — a renamed/mislabeled file should never pass validation just
 * because the browser guessed a MIME type from the extension.
 */
export function detectImageType(buffer: Buffer): ValidatedImage | null {
  if (buffer.length < 12) return null

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: "png" }
  }

  // WEBP: "RIFF"....."WEBP"
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" }
  }

  return null
}

/** True if this looks like an HEIC/HEIF file (common iPhone photo format) — used only to give a clearer rejection message. */
export function looksLikeHeic(buffer: Buffer): boolean {
  if (buffer.length < 12) return false
  const brand = buffer.toString("ascii", 8, 12).toLowerCase()
  return buffer.toString("ascii", 4, 8) === "ftyp" && (brand.startsWith("heic") || brand.startsWith("heif") || brand === "mif1")
}

export interface ValidationResult {
  ok: boolean
  error?: string
  image?: ValidatedImage
}

export function validateUpload(buffer: Buffer): ValidationResult {
  if (buffer.length === 0) {
    return { ok: false, error: "Uploaded file is empty." }
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `Image must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` }
  }

  const image = detectImageType(buffer)
  if (!image) {
    if (looksLikeHeic(buffer)) {
      return { ok: false, error: "HEIC/HEIF photos aren't supported yet — please use JPEG, PNG, or WEBP." }
    }
    return { ok: false, error: "File must be a valid JPEG, PNG, or WEBP image." }
  }

  return { ok: true, image }
}
