import crypto from "crypto"
import { createPresignedPost } from "@aws-sdk/s3-presigned-post"
import { getS3Client } from "../ai-image/s3-uploader"

/**
 * Baker image uploads — presigned, direct to S3.
 *
 * The bytes never pass through Medusa. That is not an optimisation, it is a hard constraint: this
 * install's JSON body limit is the express default (~100KB, measured — a 200KB body already 500s),
 * so any scheme that proxies an image through the backend would need that limit raised globally for
 * every route. Presigned upload avoids the question entirely and scales to thousands of bakers,
 * because our servers only ever handle the signature.
 *
 * ── Why presigned POST rather than presigned PUT ────────────────────────────────────────────────
 * A presigned PUT cannot constrain what is uploaded — the holder can send 5GB of anything. A
 * presigned POST carries a policy that S3 itself enforces: exact key, exact content type, and a
 * content-length-range. So the limits below are applied by S3, not merely asked for by us, and they
 * hold even against a caller who ignores every rule the portal's UI imposes.
 *
 * ── The key is derived from the session ─────────────────────────────────────────────────────────
 * `bakerId` comes from the verified session in the route, never from the request body, and the
 * policy pins the exact key. A baker therefore cannot write into another bakery's folder even by
 * hand-crafting the upload — the signature simply will not validate for a different path.
 *
 * ── Storage layout ──────────────────────────────────────────────────────────────────────────────
 *   pranajiva-innovations/
 *   └── bakers-images/{bakerId}/          ← the prefix OPS already established
 *       ├── profile_{uuid}.{ext}             (existing convention, unchanged)
 *       ├── banner_{uuid}.{ext}              (existing convention, unchanged)
 *       └── products/{uuid}.{ext}            ← new, for product photos
 *
 * Product photos deliberately do NOT go to the bucket root, where medusa-file-s3 puts
 * admin-uploaded catalogue images. Root is fine for a handful of files curated by staff; for baker
 * uploads it gives no per-baker isolation, no cleanup story when a bakery leaves, and invites
 * filename collisions between bakeries. Everything belonging to one baker stays under one prefix.
 */

export type BakerUploadPurpose = "product" | "profile" | "banner"

/**
 * Allowlist by MIME type, with the extension derived from the TYPE rather than the filename — a
 * baker uploading "cake.jpg.exe" gets a .jpg key, because the extension we store is never taken
 * from anything the client chose.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

/** 8MB. Phone photos routinely reach 4–6MB, so a tighter cap would reject ordinary uploads. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const MIN_UPLOAD_BYTES = 1024

/** Presigned policies are short-lived — long enough for a slow mobile upload, no longer. */
const SIGNATURE_TTL_SECONDS = 300

export interface PresignedUpload {
  /** Where to POST the multipart form. */
  url: string
  /** Policy fields that must be sent as form fields BEFORE the file part. */
  fields: Record<string, string>
  /** Where the object will be readable once uploaded. */
  publicUrl: string
  key: string
  maxBytes: number
  expiresInSeconds: number
}

function bucket(): string {
  return process.env.S3_BUCKET || "pranajiva-innovations"
}

function buildPublicUrl(key: string): string {
  const region = process.env.S3_REGION || "eu-north-1"
  const base = process.env.S3_URL || `https://${bucket()}.s3.${region}.amazonaws.com`
  return `${base.replace(/\/+$/, "")}/${key}`
}

/**
 * Builds the S3 key for one upload. Purpose decides the shape, matching what OPS already writes:
 * profile and banner are "most recent wins" singles sitting directly in the baker's folder, while
 * product photos are many and live in their own subfolder.
 */
function buildKey(bakerId: string, purpose: BakerUploadPurpose, extension: string): string {
  const uuid = crypto.randomUUID()
  if (purpose === "product") {
    return `bakers-images/${bakerId}/products/${uuid}.${extension}`
  }
  return `bakers-images/${bakerId}/${purpose}_${uuid}.${extension}`
}

export function validateUploadRequest(contentType: string, sizeBytes: number): string | null {
  if (!EXTENSION_BY_MIME[contentType]) {
    return "Photos must be a JPEG, PNG or WEBP image."
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes < MIN_UPLOAD_BYTES) {
    return "That file looks empty — please choose another photo."
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return `Photos must be under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`
  }
  return null
}

export async function createBakerUploadSignature(
  bakerId: string,
  purpose: BakerUploadPurpose,
  contentType: string,
  sizeBytes: number
): Promise<PresignedUpload> {
  const validationError = validateUploadRequest(contentType, sizeBytes)
  if (validationError) {
    throw new Error(validationError)
  }

  const key = buildKey(bakerId, purpose, EXTENSION_BY_MIME[contentType])

  const { url, fields } = await createPresignedPost(getS3Client(), {
    Bucket: bucket(),
    Key: key,
    Conditions: [
      // S3 rejects the upload unless every one of these holds. The declared size is trusted only
      // as a hint for the range; S3 measures the actual bytes.
      ["content-length-range", MIN_UPLOAD_BYTES, MAX_UPLOAD_BYTES],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: {
      "Content-Type": contentType,
      // Baker images are meant to be shown on public product and profile pages.
      acl: "public-read",
    },
    Expires: SIGNATURE_TTL_SECONDS,
  })

  return {
    url,
    fields,
    publicUrl: buildPublicUrl(key),
    key,
    maxBytes: MAX_UPLOAD_BYTES,
    expiresInSeconds: SIGNATURE_TTL_SECONDS,
  }
}
