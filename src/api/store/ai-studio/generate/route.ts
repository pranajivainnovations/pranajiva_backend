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
 *     zodiacInfluence?: { sign: string, suggestion: string }
 *     imageCount?: number     (optional, default from config)
 *   }
 *
 * Response 200:
 *   {
 *     success: true,
 *     generationId: string,
 *     designs: [{ id, imageUrl, title, description, style }],
 *     creditsRemaining: number
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
    const { prompt, style, occasion, flavor, weight, tiers, color, cakeMessage, zodiacInfluence, imageCount } = req.body as {
      prompt?: string
      style?: string
      occasion?: string
      flavor?: string
      weight?: string
      tiers?: string
      color?: string
      cakeMessage?: string
      zodiacInfluence?: { sign: string; suggestion: string }
      imageCount?: number
    }

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "Prompt is required.",
        code: "INVALID_REQUEST",
      })
    }

    if (prompt.length > 500) {
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
      prompt: prompt.trim(),
      style,
      occasion: occasion || "",
      flavor: flavor || "",
      weight: weight || undefined,
      tiers: tiers || undefined,
      color: color || undefined,
      cakeMessage: cakeMessage?.trim() || undefined,
      zodiacInfluence: zodiacInfluence || undefined,
      imageCount: count,
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
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"

    console.error("[API /store/ai-studio/generate] Error:", errorMessage)

    // Determine if it's a provider error or internal error
    const isProviderError =
      errorMessage.includes("[Replicate]") ||
      errorMessage.includes("[OpenAI]") ||
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
