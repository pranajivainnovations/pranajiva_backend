/**
 * S3 Uploader
 *
 * Downloads images from provider's temporary URLs and uploads them
 * permanently to our S3 bucket.
 *
 * Storage structure:
 *   pranajiva-innovations/
 *   └── ai-studio/
 *       └── cake-designs/
 *           └── {generation_id}/
 *               ├── design-1-{short_uuid}.png
 *               ├── design-2-{short_uuid}.png
 *               └── design-3-{short_uuid}.png
 *
 * Provider URLs are temporary (expire in minutes/hours).
 * Our S3 URLs are permanent and served publicly.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { GeneratedImage } from "./types"

// ─── S3 Client (singleton) ───────────────────────────────────────────────────

let s3Client: S3Client | null = null

function getS3Client(): S3Client {
  if (s3Client) return s3Client

  const region = process.env.S3_REGION || "eu-north-1"
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("[S3 Uploader] S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set")
  }

  s3Client = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  return s3Client
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UploadedImage {
  /** Permanent public URL on our S3 */
  url: string
  /** S3 key (path within bucket) */
  key: string
  /** Original index from generation */
  index: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generates a short random ID for file uniqueness.
 * Example output: "a7f2c3"
 */
function shortId(): string {
  return Math.random().toString(36).substring(2, 8)
}

/**
 * Builds the S3 key for a generated cake design image.
 *
 * Pattern: ai-studio/cake-designs/{generationId}/design-{index}-{shortId}.png
 */
function buildS3Key(generationId: string, index: number): string {
  const prefix = process.env.AI_STUDIO_S3_PREFIX || "ai-studio/cake-designs"
  return `${prefix}/${generationId}/design-${index + 1}-${shortId()}.png`
}

/**
 * Builds the public URL for an S3 object.
 */
function buildPublicUrl(s3Key: string): string {
  const bucket = process.env.S3_BUCKET || "pranajiva-innovations"
  const region = process.env.S3_REGION || "eu-north-1"
  const baseUrl = process.env.S3_URL || `https://${bucket}.s3.${region}.amazonaws.com`
  return `${baseUrl}/${s3Key}`
}

// ─── Upload Functions ────────────────────────────────────────────────────────

/**
 * Downloads an image from a temporary provider URL and uploads it to S3.
 *
 * @param providerUrl - Temporary URL from AI provider
 * @param s3Key - The key (path) to store in S3
 * @returns Public URL of the uploaded image
 */
async function uploadSingleImage(providerUrl: string, s3Key: string): Promise<string> {
  const bucket = process.env.S3_BUCKET || "pranajiva-innovations"

  // 1. Download image from provider's temporary URL
  const response = await fetch(providerUrl)

  if (!response.ok) {
    throw new Error(
      `[S3 Uploader] Failed to download image from provider: ${response.status} ${response.statusText}`
    )
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Detect content type from response headers or default to png
  const contentType = response.headers.get("content-type") || "image/png"

  // 2. Upload to S3
  const client = getS3Client()

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
    // Make publicly readable
    ACL: "public-read",
  })

  await client.send(command)

  // 3. Return permanent public URL
  return buildPublicUrl(s3Key)
}

/**
 * Uploads all generated images from a single generation to S3.
 *
 * @param images - Array of generated images with temporary provider URLs
 * @param generationId - Generation ID for folder grouping
 * @returns Array of uploaded images with permanent S3 URLs
 */
export async function uploadGeneratedImages(
  images: GeneratedImage[],
  generationId: string
): Promise<UploadedImage[]> {
  const results: UploadedImage[] = []

  // Upload all images in parallel
  const uploadPromises = images.map(async (image) => {
    const s3Key = buildS3Key(generationId, image.index)

    try {
      const url = await uploadSingleImage(image.url, s3Key)
      return { url, key: s3Key, index: image.index }
    } catch (error) {
      console.error(
        `[S3 Uploader] Failed to upload image ${image.index} for generation ${generationId}:`,
        error
      )
      // Return provider URL as fallback (temporary but better than nothing)
      // The generation service will mark this appropriately
      return { url: image.url, key: "", index: image.index }
    }
  })

  const uploaded = await Promise.all(uploadPromises)

  // Separate successful uploads from fallbacks
  for (const item of uploaded) {
    results.push(item)
  }

  const successCount = results.filter((r) => r.key !== "").length
  const fallbackCount = results.filter((r) => r.key === "").length

  if (fallbackCount > 0) {
    console.warn(
      `[S3 Uploader] ${fallbackCount}/${results.length} images fell back to provider URLs for generation ${generationId}`
    )
  }

  console.log(
    `[S3 Uploader] Uploaded ${successCount}/${results.length} images for generation ${generationId}`
  )

  return results
}
