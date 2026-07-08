/**
 * AI Generation Service — The Orchestrator
 *
 * This is the main entry point for generating cake designs.
 * It coordinates all steps:
 *
 *   1. Build optimized prompt
 *   2. Call AI provider
 *   3. Upload images to S3
 *   4. Extract tags
 *   5. Persist to database (ai_studio schema)
 *   6. Return results
 *
 * This service does NOT handle:
 *   - Authentication (API route handles that)
 *   - Rate limiting (separate service, called before this)
 *   - Credit checking/deduction (separate service, called before/after this)
 *
 * It focuses purely on: prompt → images → storage → response
 */

import { Pool } from "pg"
import crypto from "crypto"
import { GenerationRequest, GenerationResult, DesignOutput, GenerateOptions } from "./types"
import { getImageProvider, getProviderConfig } from "./provider-factory"
import { buildCakePrompt, generateDesignTitle, generateDesignDescription } from "./prompt-builder"
import { uploadGeneratedImages, UploadedImage } from "./s3-uploader"
import { extractTags } from "./tag-extractor"

// ─── Database connection (reuses Medusa's DATABASE_URL) ──────────────────────

let pool: Pool | null = null

/** Generate a UUID v4 using Node.js built-in crypto */
function uuidv4(): string {
  return crypto.randomUUID()
}

function getPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("[AI Generation] DATABASE_URL is not set")
  }

  pool = new Pool({ connectionString, max: 5 })
  return pool
}

// ─── Main Generation Function ────────────────────────────────────────────────

/**
 * Generates cake design images from a user request.
 *
 * @param request - The generation request (prompt, style, occasion, etc.)
 * @returns GenerationResult with designs and metadata
 * @throws Error if generation fails at any critical step
 */
export async function generateCakeDesigns(
  request: GenerationRequest
): Promise<GenerationResult> {
  const db = getPool()
  const config = getProviderConfig()
  const generationId = uuidv4()
  const startTime = Date.now()

  // ── Step 1: Create generation record (status: pending) ─────────────────────
  await db.query(
    `INSERT INTO ai_studio.generations
      (id, customer_id, prompt, style, occasion, flavor, zodiac_sign, zodiac_suggestion, provider, provider_model, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW())`,
    [
      generationId,
      request.customerId,
      request.prompt,
      request.style,
      request.occasion || null,
      request.flavor || null,
      request.zodiacInfluence?.sign || null,
      request.zodiacInfluence?.suggestion || null,
      config.provider,
      config.model,
    ]
  )

  try {
    // ── Step 2: Update status to processing ────────────────────────────────────
    await db.query(
      `UPDATE ai_studio.generations SET status = 'processing', started_at = NOW() WHERE id = $1`,
      [generationId]
    )

    // ── Step 3: Build the optimized prompt ─────────────────────────────────────
    const fullPrompt = buildCakePrompt(request)

    // ── Step 4: Call AI provider ───────────────────────────────────────────────
    const provider = getImageProvider()
    const imageCount = request.imageCount || config.imageCount

    const options: GenerateOptions = {
      imageCount,
      width: config.width,
      height: config.height,
      quality: config.quality,
      aspectRatio: "1:1",
    }

    const generatedImages = await provider.generate(fullPrompt, options)

    if (generatedImages.length === 0) {
      throw new Error("Provider returned zero images")
    }

    // ── Step 5: Upload images to S3 ────────────────────────────────────────────
    const uploadedImages = await uploadGeneratedImages(generatedImages, generationId)

    // ── Step 6: Extract tags ───────────────────────────────────────────────────
    const tags = extractTags(request)

    // ── Step 7: Save cake_designs records ──────────────────────────────────────
    const designs: DesignOutput[] = []

    for (const uploaded of uploadedImages) {
      const designId = uuidv4()
      const title = generateDesignTitle(request, uploaded.index)
      const description = generateDesignDescription(request, uploaded.index)

      await db.query(
        `INSERT INTO ai_studio.cake_designs
          (id, generation_id, customer_id, image_url, s3_key, image_index,
           prompt, style, occasion, flavor, zodiac_sign,
           provider, provider_model, tags, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active', NOW(), NOW())`,
        [
          designId,
          generationId,
          request.customerId,
          uploaded.url,
          uploaded.key,
          uploaded.index,
          request.prompt,
          request.style,
          request.occasion || null,
          request.flavor || null,
          request.zodiacInfluence?.sign || null,
          config.provider,
          config.model,
          tags,
        ]
      )

      designs.push({
        id: designId,
        imageUrl: uploaded.url,
        title,
        description,
        style: request.style,
      })
    }

    // ── Step 8: Update generation record (status: completed) ───────────────────
    const durationMs = Date.now() - startTime

    await db.query(
      `UPDATE ai_studio.generations
       SET status = 'completed',
           image_count = $2,
           completed_at = NOW(),
           duration_ms = $3
       WHERE id = $1`,
      [generationId, designs.length, durationMs]
    )

    console.log(
      `[AI Generation] Completed: ${generationId} | ${designs.length} images | ${durationMs}ms | provider: ${config.provider}/${config.model}`
    )

    // ── Step 9: Return result ──────────────────────────────────────────────────
    return {
      generationId,
      designs,
      creditsRemaining: -1, // Will be set by the credits service (caller)
    }
  } catch (error) {
    // ── Handle failure ─────────────────────────────────────────────────────────
    const durationMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : "Unknown error"

    await db.query(
      `UPDATE ai_studio.generations
       SET status = 'failed',
           failed_reason = $2,
           completed_at = NOW(),
           duration_ms = $3
       WHERE id = $1`,
      [generationId, errorMessage, durationMs]
    ).catch((dbErr) => {
      console.error("[AI Generation] Failed to update generation status:", dbErr)
    })

    console.error(
      `[AI Generation] Failed: ${generationId} | ${durationMs}ms | error: ${errorMessage}`
    )

    throw error
  }
}
