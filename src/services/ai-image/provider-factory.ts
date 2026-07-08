/**
 * Provider Factory
 *
 * Reads environment config and returns the correct ImageProvider instance.
 * Switching providers = changing env vars, zero code changes.
 */

import { ImageProvider, ProviderConfig } from "./types"
import { ReplicateProvider } from "./providers/replicate-provider"
// import { OpenAIProvider } from "./providers/openai-provider"
// import { StabilityProvider } from "./providers/stability-provider"

// ─── Read config from environment ────────────────────────────────────────────

export function getProviderConfig(): ProviderConfig {
  const provider = (process.env.AI_IMAGE_PROVIDER || "replicate") as ProviderConfig["provider"]

  let apiKey = ""
  let model = ""

  switch (provider) {
    case "replicate":
      apiKey = process.env.REPLICATE_API_TOKEN || ""
      model = process.env.AI_IMAGE_MODEL || "black-forest-labs/flux-1.1-pro"
      break
    case "openai":
      apiKey = process.env.OPENAI_API_KEY || ""
      model = process.env.AI_IMAGE_MODEL || "dall-e-3"
      break
    case "stability":
      apiKey = process.env.STABILITY_API_KEY || ""
      model = process.env.AI_IMAGE_MODEL || "stable-diffusion-xl"
      break
  }

  return {
    provider,
    model,
    apiKey,
    imageCount: parseInt(process.env.AI_IMAGE_COUNT || "3", 10),
    width: parseInt(process.env.AI_IMAGE_WIDTH || "1024", 10),
    height: parseInt(process.env.AI_IMAGE_HEIGHT || "1024", 10),
    quality: (process.env.AI_IMAGE_QUALITY || "high") as "standard" | "high",
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let cachedProvider: ImageProvider | null = null

export function getImageProvider(): ImageProvider {
  if (cachedProvider) return cachedProvider

  const config = getProviderConfig()

  if (!config.apiKey) {
    throw new Error(
      `[AI Image] No API key configured for provider "${config.provider}". ` +
      `Set the appropriate env var (REPLICATE_API_TOKEN / OPENAI_API_KEY / STABILITY_API_KEY).`
    )
  }

  switch (config.provider) {
    case "replicate":
      cachedProvider = new ReplicateProvider(config.apiKey, config.model)
      break
    case "openai":
      // cachedProvider = new OpenAIProvider(config.apiKey, config.model)
      throw new Error("[AI Image] OpenAI provider not yet implemented. Switch to replicate or add the adapter.")
    case "stability":
      // cachedProvider = new StabilityProvider(config.apiKey, config.model)
      throw new Error("[AI Image] Stability provider not yet implemented. Switch to replicate or add the adapter.")
    default:
      throw new Error(`[AI Image] Unknown provider: "${config.provider}"`)
  }

  return cachedProvider
}

/**
 * Reset cached provider (useful for testing or if env vars change at runtime)
 */
export function resetProvider(): void {
  cachedProvider = null
}
