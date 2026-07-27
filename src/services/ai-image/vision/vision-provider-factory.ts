/**
 * Vision Provider Factory
 *
 * Backend-only config — VISION_PROVIDER / VISION_MODEL env vars. Unlike
 * provider-factory.ts (image generation), there's no customer-facing picker
 * and no per-request override: nobody outside the team chooses which model
 * looks at an uploaded reference photo.
 *
 * Defaults to Anthropic (claude-haiku-4-5-20251001) — reuses the same key
 * and provider the text elaborator already uses, and Claude Haiku already
 * supports image input. Switch to OpenAI by setting VISION_PROVIDER=openai
 * and VISION_MODEL to a vision-capable OpenAI model (e.g. gpt-4o) — both API
 * keys are already configured for other parts of this pipeline either way.
 */

import { VisionAnalyzer } from "./types"
import { AnthropicVisionProvider } from "./anthropic-vision-provider"
import { OpenAIVisionProvider } from "./openai-vision-provider"

let cached: VisionAnalyzer | null = null

export function getVisionAnalyzer(): VisionAnalyzer {
  if (cached) return cached

  const provider = (process.env.VISION_PROVIDER || "anthropic").toLowerCase()

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error("[Vision] VISION_PROVIDER=openai but OPENAI_API_KEY is not set")
    }
    const model = process.env.VISION_MODEL || "gpt-4o"
    cached = new OpenAIVisionProvider(apiKey, model)
    return cached
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error("[Vision] ANTHROPIC_API_KEY is not set")
  }
  const model = process.env.VISION_MODEL || "claude-haiku-4-5-20251001"
  cached = new AnthropicVisionProvider(apiKey, model)
  return cached
}

/** Reset the cached analyzer — useful if env vars change at runtime (e.g. tests). */
export function resetVisionAnalyzer(): void {
  cached = null
}
