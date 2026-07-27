/**
 * Personal Uploads — S3 storage for customer-owned images
 *
 * Distinct from s3-uploader.ts (which stores our own AI-generated,
 * publicly-showcased designs). Everything here is customer-owned personal
 * data — reference photos, profile images — and is private by default.
 *
 * Storage structure (customer-scoped, NOT generation-scoped — an upload can
 * happen before any generation exists):
 *
 *   {bucket}/ai-studio/personal/{customerId}/
 *     ├── reference-uploads/{uploadId}.{ext}   ← many per customer, unique ids
 *     └── profile/profile-image                 ← one per customer, fixed key (overwrite on replace)
 *
 * Reference uploads are read only by our own backend (to feed a vision/
 * generation step later) — never served over a public or customer-facing
 * URL. Profile images are meant to be visible to other logged-in customers
 * eventually (e.g. next to a comment), so they're served via a short-lived
 * presigned URL on request, never given a permanent public ACL.
 */

import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import crypto from "crypto"
import { getS3Client } from "./s3-uploader"

const PERSONAL_PREFIX = "ai-studio/personal"
const PROFILE_URL_TTL_SECONDS = 15 * 60

function bucket(): string {
  return process.env.S3_BUCKET || "pranajiva-innovations"
}

function referenceUploadKey(customerId: string, uploadId: string, extension: string): string {
  return `${PERSONAL_PREFIX}/${customerId}/reference-uploads/${uploadId}.${extension}`
}

function profileImageKey(customerId: string): string {
  // No extension — Content-Type on the object carries the real format, so
  // re-uploading in a different format still overwrites the same one key.
  return `${PERSONAL_PREFIX}/${customerId}/profile/profile-image`
}

/**
 * Stores a reference upload (theme inspiration / recreate-this-cake /
 * photo-cake source). Private ACL — only our backend ever reads this
 * directly via S3, never over a public URL.
 */
export async function storeReferenceUpload(
  buffer: Buffer,
  customerId: string,
  mimeType: string,
  extension: string
): Promise<{ s3Key: string; uploadId: string }> {
  const uploadId = crypto.randomUUID()
  const s3Key = referenceUploadKey(customerId, uploadId, extension)

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: s3Key,
      Body: buffer,
      ContentType: mimeType,
      ACL: "private",
      CacheControl: "private, no-cache", // may need to be deleted/replaced later — never cache aggressively
    })
  )

  return { s3Key, uploadId }
}

/**
 * Stores/replaces the customer's profile image at a fixed key — uploading a
 * new one silently overwrites the old one, no orphaned versions accumulate.
 */
export async function storeProfileImage(
  buffer: Buffer,
  customerId: string,
  mimeType: string
): Promise<{ s3Key: string }> {
  const s3Key = profileImageKey(customerId)

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: s3Key,
      Body: buffer,
      ContentType: mimeType,
      ACL: "private",
      CacheControl: "private, max-age=300", // short cache — may be replaced at any time
    })
  )

  return { s3Key }
}

/**
 * Short-lived signed URL for viewing a profile image — the object itself
 * stays private in S3 forever; only someone who already passed our own
 * "are you logged in" check on the route ever gets one of these.
 */
export async function getProfileImageViewUrl(s3Key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket(), Key: s3Key })
  return getSignedUrl(getS3Client(), command, { expiresIn: PROFILE_URL_TTL_SECONDS })
}

/**
 * Reads a reference upload's raw bytes directly (server-side only — this is
 * how the vision-analysis step and, later, image-to-image providers get at
 * the actual image). Never exposed as a URL to any client.
 */
export async function getReferenceUploadBuffer(s3Key: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const result = await getS3Client().send(new GetObjectCommand({ Bucket: bucket(), Key: s3Key }))
  if (!result.Body) {
    throw new Error(`[Personal Uploads] No body returned for ${s3Key}`)
  }
  const bytes = await result.Body.transformToByteArray()
  return { buffer: Buffer.from(bytes), mimeType: result.ContentType || "image/jpeg" }
}
