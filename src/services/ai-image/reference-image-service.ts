/**
 * Reference Image Service
 *
 * Bridges an uploaded ai_studio.personal_uploads row to the vision analyzer.
 * Ownership is checked on every read — a customer must never be able to
 * trigger analysis of another customer's private upload by guessing or
 * reusing an id that isn't theirs.
 */

import { getAiStudioDbPool } from "./db"
import { getReferenceUploadBuffer } from "./personal-uploads-s3"
import { getVisionAnalyzer } from "./vision/vision-provider-factory"

const INSTRUCTIONS: Record<string, string> = {
  theme_reference:
    "This photo is a source of THEME/STYLE inspiration for a cake design, not something to literally " +
    "reproduce. Describe its dominant colors, mood, setting, and 2-4 concrete visual motifs that could " +
    "translate into cake decoration. Describe the theme it evokes, not a request to copy this exact photo.",
  recreate_cake:
    "This photo is a cake the customer wants recreated closely. Describe its shape, tiers, color palette, " +
    "specific decorations (toppers, piping, textures, motifs), and any visible text, in enough concrete " +
    "detail that another baker could recreate it from your description alone.",
  // V1: reuses the same generative pipeline as the other two purposes — this
  // produces an AI-STYLIZED depiction of the subject on the cake, not a
  // literal photo print. True literal photo-printing (the real product
  // "photo cake" usually means) is intentionally deferred — see
  // AI-Context/PROJECT-TRACKER/STATUS.md's V2 TODO for the separate,
  // compositing-based pipeline that does that properly.
  photo_cake:
    "This photo's subject (a person, pet, or object) should be featured prominently on the cake. Describe " +
    "the subject's key visual details (appearance, colors, distinguishing features, pose/expression) in " +
    "enough concrete detail that an image-generation model can depict a similar-looking likeness on the " +
    "cake's surface. This will be a stylized artistic depiction, not a literal photo reproduction — do not " +
    "describe it as printing the exact photo.",
}

export interface ReferenceImageLookup {
  uploadId: string
  customerId: string
}

/**
 * Fetches, verifies ownership of, and analyzes an uploaded reference image.
 * Purpose is read from the upload's own DB row (set once, at upload time) —
 * deliberately NOT re-passed at generate time too, to avoid the two ever
 * disagreeing about what the customer actually asked for.
 *
 * Returns null (never throws) on any failure — a broken/missing reference
 * image, or an unrecognized purpose, must never block generation, same
 * principle as every other optional LLM step in this pipeline (horoscope
 * quote, elaboration itself).
 */
export async function analyzeReferenceImage(input: ReferenceImageLookup): Promise<string | null> {
  const db = getAiStudioDbPool()

  try {
    const result = await db.query(
      `SELECT s3_key, customer_id, purpose FROM ai_studio.personal_uploads WHERE id = $1`,
      [input.uploadId]
    )
    const row = result.rows[0]

    if (!row) {
      console.warn(`[Reference Image] Upload ${input.uploadId} not found`)
      return null
    }
    if (row.customer_id !== input.customerId) {
      console.error(`[Reference Image] Ownership mismatch on upload ${input.uploadId} — refusing to analyze`)
      return null
    }

    const instructions = INSTRUCTIONS[row.purpose]
    if (!instructions) {
      console.warn(`[Reference Image] Purpose "${row.purpose}" isn't wired to vision analysis yet — skipping`)
      return null
    }

    const { buffer, mimeType } = await getReferenceUploadBuffer(row.s3_key)
    const analyzer = getVisionAnalyzer()
    return await analyzer.analyzeImage({ imageBuffer: buffer, mimeType, instructions })
  } catch (error) {
    console.error("[Reference Image] Analysis failed, continuing without it:", error)
    return null
  }
}

/** Marks an upload as consumed by a generation — called after generation succeeds. */
export async function markUploadUsed(uploadId: string, generationId: string): Promise<void> {
  const db = getAiStudioDbPool()
  await db
    .query(
      `UPDATE ai_studio.personal_uploads SET status = 'used', generation_id = $2, updated_at = NOW() WHERE id = $1`,
      [uploadId, generationId]
    )
    .catch((err) => {
      console.error("[Reference Image] Failed to mark upload used:", err)
    })
}
