import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { generateCakeDesigns } from "../../../../services/ai-image/ai-generation-service"
import type { GenerationRequest } from "../../../../services/ai-image/types"

/**
 * POST /store/ai-studio/generate
 *
 * Generates AI cake design images for an authenticated customer.
 *
 * Request body:
 *   {
 *     prompt: string          (required, max 500 chars)
 *     style: string           (required)
 *     occasion: string        (optional)
 *     flavor: string          (optional)
 *     weight?: string
 *     tiers?: string
 *     shape?: string
 *     color?: string
 *     cakeMessage?: string
 *     zodiacInfluence?: { sign: string, suggestion: string }
 *     imageCount?: number     (optional, default from config)
 *     imageProvider?: string  (optional — e.g. "replicate" | "openai"; falls back to AI_IMAGE_PROVIDER env default)
 *     imageModel?: string     (optional — must be on that provider's request-allowlist or it's ignored)
 *     referenceUploadId?: string     (optional — id of a row in ai_studio.personal_uploads; ownership verified
 *                                     server-side; purpose is read from that row itself, not passed here too)
 *   }
 *
 * prompt is normally required, but may be omitted if referenceUploadId is
 * given — a customer relying purely on an uploaded photo may never type one.
 *
 * Response 200:
 *   {
 *     success: true,
 *     generationId: string,
 *     designs: [{ id, imageUrl, title, description, style }],
 *     creditsRemaining: number,
 *     horoscopeQuote?: string   (present only when zodiacInfluence was sent and generation succeeded)
 *   }
 *
 * Response 401: Not authenticated
 * Response 400: Invalid request body
 * Response 429: Rate limited
 * Response 500: Provider or internal error
 *
 * Auth: Requires valid _medusa_jwt cookie (Medusa customer session)
 *
 * TODO (next phases):
 *   - Rate limiting (Redis-based, before generation)
 *   - Credit check/deduction (before/after generation)
 *   - Generation lock (prevent duplicate submits)
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    // ── 1. Authentication ──────────────────────────────────────────────────────
    const customerId = req.user?.customer_id

    if (!customerId) {
      return res.status(401).json({
        success: false,
        error: "Authentication required. Please log in to generate designs.",
        code: "AUTH_REQUIRED",
      })
    }

    // ── 2. Validate request body ───────────────────────────────────────────────
    const {
      prompt,
      style,
      occasion,
      flavor,
      weight,
      tiers,
      shape,
      color,
      cakeMessage,
      zodiacInfluence,
      age,
      imageCount,
      imageProvider,
      imageModel,
      referenceUploadId,
    } = req.body as {
      prompt?: string
      style?: string
      occasion?: string
      flavor?: string
      weight?: string
      tiers?: string
      shape?: string
      color?: string
      cakeMessage?: string
      zodiacInfluence?: { sign: string; suggestion: string }
      age?: number
      imageCount?: number
      imageProvider?: string
      imageModel?: string
      referenceUploadId?: string
    }

    const hasReferenceImage = typeof referenceUploadId === "string" && referenceUploadId.length > 0

    // A typed prompt is normally required, but a reference-image upload can
    // stand in for it entirely — a customer relying purely on an uploaded
    // photo may never type anything.
    if ((!prompt || typeof prompt !== "string" || prompt.trim().length === 0) && !hasReferenceImage) {
      return res.status(400).json({
        success: false,
        error: "Prompt is required (or upload a reference image).",
        code: "INVALID_REQUEST",
      })
    }

    if (prompt && prompt.length > 500) {
      return res.status(400).json({
        success: false,
        error: "Prompt must be 500 characters or less.",
        code: "INVALID_REQUEST",
      })
    }

    if (!style || typeof style !== "string") {
      return res.status(400).json({
        success: false,
        error: "Style is required.",
        code: "INVALID_REQUEST",
      })
    }

    // Validate imageCount if provided
    const count = imageCount ? Math.min(Math.max(1, imageCount), 4) : undefined

    // ── 3. Build generation request ────────────────────────────────────────────
    const generationRequest: GenerationRequest = {
      customerId,
      prompt: prompt?.trim() || "",
      style,
      occasion: occasion || "",
      flavor: flavor || "",
      weight: weight || undefined,
      tiers: tiers || undefined,
      shape: shape || undefined,
      color: color || undefined,
      cakeMessage: cakeMessage?.trim() || undefined,
      zodiacInfluence: zodiacInfluence || undefined,
      age: typeof age === "number" && age > 0 ? age : undefined,
      imageCount: count,
      imageProvider: typeof imageProvider === "string" ? imageProvider : undefined,
      imageModel: typeof imageModel === "string" ? imageModel : undefined,
      referenceUploadId: hasReferenceImage ? referenceUploadId : undefined,
    }

    // ── 4. Generate ────────────────────────────────────────────────────────────
    // TODO: Add rate limiting check here (Phase 3)
    // TODO: Add credit check here (Phase 2)
    // TODO: Add generation lock here (Phase 3)

    const result = await generateCakeDesigns(generationRequest)

    // TODO: Deduct credit here (Phase 2)
    // TODO: Release generation lock here (Phase 3)

    // ── 5. Return response ─────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      generationId: result.generationId,
      designs: result.designs,
      creditsRemaining: result.creditsRemaining,
      horoscopeQuote: result.horoscopeQuote,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"

    console.error("[API /store/ai-studio/generate] Error:", errorMessage)

    // Determine if it's a provider error or internal error
    const isProviderError =
      errorMessage.includes("[Replicate]") ||
      errorMessage.includes("[OpenAI Image]") ||
      errorMessage.includes("[Gemini Image]") ||
      errorMessage.includes("[Stability]") ||
      errorMessage.includes("Provider returned zero images")

    return res.status(isProviderError ? 502 : 500).json({
      success: false,
      error: isProviderError
        ? "AI provider is temporarily unavailable. Please try again in a moment."
        : "Something went wrong. Please try again.",
      code: isProviderError ? "PROVIDER_ERROR" : "INTERNAL_ERROR",
    })
  }
}
