import { PutObjectCommand } from "@aws-sdk/client-s3"
import { Pool } from "pg"

import { getS3Client } from "../ai-image/s3-uploader"

/**
 * Where a reel's bytes and rows live.
 *
 * Its own pool rather than ai-image's `getAiStudioDbPool`, for the same reason that one exists
 * separately from Medusa's: a subsystem owning its connections means a slow query in one cannot
 * starve the other. The S3 *client* is shared, because that is a credentialed singleton and a
 * second one would be a second set of sockets to the same bucket for no gain.
 */

let pool: Pool | null = null

export function getSocialDbPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[social] DATABASE_URL is not set")

  /* Small on purpose. A reel is a handful of writes around calls that take minutes; the
     concurrency here is nothing like a storefront's. */
  pool = new Pool({ connectionString, max: 4 })
  return pool
}

function shortId(): string {
  return Math.random().toString(36).substring(2, 8)
}

function publicUrl(key: string): string {
  const bucket = process.env.S3_BUCKET || "pranajiva-innovations"
  const region = process.env.S3_REGION || "eu-north-1"
  const base = process.env.S3_URL || `https://${bucket}.s3.${region}.amazonaws.com`
  return `${base}/${key}`
}

/**
 * Stores a finished shot.
 *
 * Keyed by reel and sequence so the bucket reads like the timeline it represents, and a shot
 * regenerated after a failure cannot overwrite the one before it — the short id is what keeps a
 * retry from silently replacing bytes somebody has already reviewed.
 */
export async function putShotVideo(
  reelId: string,
  seq: number,
  bytes: Buffer
): Promise<{ key: string; url: string }> {
  const bucket = process.env.S3_BUCKET || "pranajiva-innovations"
  const prefix = process.env.SOCIAL_S3_PREFIX || "social/reels"
  const key = `${prefix}/${reelId}/shot-${String(seq).padStart(2, "0")}-${shortId()}.mp4`

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: "video/mp4",
      /* Inline so a preview plays in the browser instead of downloading, which is the whole point
         of the shot list on the builder screen. */
      ContentDisposition: "inline",
    })
  )

  return { key, url: publicUrl(key) }
}

/**
 * Stores an anchor image.
 *
 * Anchor images are kept rather than passed through, because a shot that has to be regenerated
 * three weeks later has to be anchored to the SAME frame — "use the reference image" is only a
 * reproducible instruction if the reference still exists.
 */
export async function putAnchorImage(
  reelId: string,
  bytes: Buffer,
  contentType: string
): Promise<{ key: string; url: string }> {
  const bucket = process.env.S3_BUCKET || "pranajiva-innovations"
  const prefix = process.env.SOCIAL_S3_PREFIX || "social/reels"
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg"
  const key = `${prefix}/${reelId}/anchors/${shortId()}.${ext}`

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      ContentDisposition: "inline",
    })
  )

  return { key, url: publicUrl(key) }
}

/** Reads an anchor back out of S3 so a shot can be sent to Google with it. */
export async function fetchAnchorImage(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const res = await fetch(publicUrl(key))
  if (!res.ok) return null

  return {
    data: Buffer.from(await res.arrayBuffer()),
    mimeType: res.headers.get("content-type") || "image/jpeg",
  }
}
