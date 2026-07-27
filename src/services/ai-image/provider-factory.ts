/**
 * Provider Factory
 *
 * Reads environment config and returns the correct ImageProvider instance.
 * The provider/model can also be overridden per request (e.g. a customer's
 * model picker in the UI) — env vars are only the DEFAULT when no override
 * is given, not the only way to choose.
 */

import { ImageProvider, ProviderConfig } from "./types"
import { ReplicateProvider } from "./providers/replicate-provider"
import { OpenAIProvider } from "./providers/openai-provider"
import { GeminiProvider } from "./providers/gemini-provider"
// import { StabilityProvider } from "./providers/stability-provider"

export interface ProviderOverride {
  provider?: string
  model?: string
}

const KNOWN_PROVIDERS = ["replicate", "openai", "gemini", "stability"] as const

// A request-level model choice must appear here for its provider, or it's
// ignored — this is the trust boundary between "admin sets AI_IMAGE_MODEL in
// env" (trusted, no restriction) and "a customer's request body picked a
// model" (untrusted — never let arbitrary client input reach a paid API).
const ALLOWED_REQUEST_MODELS: Record<string, string[]> = {
  replicate: ["black-forest-labs/flux-1.1-pro"],
  openai: ["gpt-image-1", "dall-e-3", "dall-e-2"],
  gemini: ["gemini-2.5-flash-image"],
  stability: ["stable-diffusion-xl"],
}

// ─── Read config from environment (+ optional request override) ─────────────

export function getProviderConfig(override?: ProviderOverride): ProviderConfig {
  const requestedProvider = override?.provider
  const provider = (
    requestedProvider && (KNOWN_PROVIDERS as readonly string[]).includes(requestedProvider)
      ? requestedProvider
      : process.env.AI_IMAGE_PROVIDER || "replicate"
  ) as ProviderConfig["provider"]

  let apiKey = ""
  let defaultModel = ""

  switch (provider) {
    case "replicate":
      apiKey = process.env.REPLICATE_API_TOKEN || ""
      defaultModel = "black-forest-labs/flux-1.1-pro"
      break
    case "openai":
      apiKey = process.env.OPENAI_API_KEY || ""
      defaultModel = "gpt-image-1"
      break
    case "gemini":
      apiKey = process.env.GEMINI_API_KEY || ""
      defaultModel = "gemini-2.5-flash-image"
      break
    case "stability":
      apiKey = process.env.STABILITY_API_KEY || ""
      defaultModel = "stable-diffusion-xl"
      break
  }

  // AI_IMAGE_MODEL is scoped to whichever provider AI_IMAGE_PROVIDER names —
  // it must NOT leak into a different provider chosen via override (e.g. env
  // set to Replicate's FLUX model string, but the request picked "openai").
  // Applying it regardless of the active provider was the bug that sent
  // "black-forest-labs/flux-1.1-pro" to OpenAI's API as a model name.
  const envDefaultProvider = process.env.AI_IMAGE_PROVIDER || "replicate"
  const envModelAppliesHere = provider === envDefaultProvider

  const requestedModel = override?.model
  const model =
    requestedModel && ALLOWED_REQUEST_MODELS[provider]?.includes(requestedModel)
      ? requestedModel
      : envModelAppliesHere && process.env.AI_IMAGE_MODEL
      ? process.env.AI_IMAGE_MODEL
      : defaultModel

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
//
// Cached per provider+model combination (not a single instance) since which
// one is requested can now vary per generation, not just per deployment.

const providerCache = new Map<string, ImageProvider>()

export function getImageProvider(override?: ProviderOverride): ImageProvider {
  const config = getProviderConfig(override)
  const cacheKey = `${config.provider}:${config.model}`

  const cached = providerCache.get(cacheKey)
  if (cached) return cached

  if (!config.apiKey) {
    throw new Error(
      `[AI Image] No API key configured for provider "${config.provider}". ` +
      `Set the appropriate env var (REPLICATE_API_TOKEN / OPENAI_API_KEY / GEMINI_API_KEY / STABILITY_API_KEY).`
    )
  }

  let instance: ImageProvider

  switch (config.provider) {
    case "replicate":
      instance = new ReplicateProvider(config.apiKey, config.model)
      break
    case "openai":
      instance = new OpenAIProvider(config.apiKey, config.model)
      break
    case "gemini":
      instance = new GeminiProvider(config.apiKey, config.model)
      break
    case "stability":
      // instance = new StabilityProvider(config.apiKey, config.model)
      throw new Error("[AI Image] Stability provider not yet implemented. Switch to replicate or add the adapter.")
    default:
      throw new Error(`[AI Image] Unknown provider: "${config.provider}"`)
  }

  providerCache.set(cacheKey, instance)
  return instance
}

/**
 * Clear the provider cache (useful for testing or if env vars change at runtime)
 */
export function resetProvider(): void {
  providerCache.clear()
}
