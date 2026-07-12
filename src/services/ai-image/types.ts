/**
 * AI Image Generation — Shared types and provider interface.
 *
 * All providers (Replicate, OpenAI, Stability, etc.) must implement
 * the ImageProvider interface. The rest of the system only talks
 * through this contract — never directly to a provider.
 */

// ─── Generation Options ─────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Number of images to generate (default: 3) */
  imageCount: number
  /** Image width in pixels */
  width: number
  /** Image height in pixels */
  height: number
  /** Quality level */
  quality: "standard" | "high"
  /** Aspect ratio hint (some providers use this instead of w/h) */
  aspectRatio?: string
}

// ─── Generated Image Result ─────────────────────────────────────────────────

export interface GeneratedImage {
  /** URL of the generated image (provider-hosted, temporary) */
  url: string
  /** Index in the batch (0, 1, 2...) */
  index: number
}

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface ImageProvider {
  /** Provider name for logging/auditing */
  readonly name: string
  /** Model identifier for logging/auditing */
  readonly model: string

  /**
   * Generate images from a prompt.
   *
   * @param prompt - The fully constructed prompt (already processed by prompt builder)
   * @param options - Generation options (count, size, quality)
   * @returns Array of generated image objects with temporary provider URLs
   * @throws Error if generation fails (caller handles retry/credit logic)
   */
  generate(prompt: string, options: GenerateOptions): Promise<GeneratedImage[]>
}

// ─── Provider Configuration ─────────────────────────────────────────────────

export interface ProviderConfig {
  provider: "replicate" | "openai" | "stability"
  model: string
  apiKey: string
  imageCount: number
  width: number
  height: number
  quality: "standard" | "high"
}

// ─── Generation Request (from API route to service) ─────────────────────────

export interface GenerationRequest {
  customerId: string
  prompt: string
  style: string
  occasion: string
  flavor: string
  weight?: string
  tiers?: string
  color?: string
  cakeMessage?: string
  zodiacInfluence?: {
    sign: string
    suggestion: string
  }
  imageCount?: number
}

// ─── Generation Result (from service to API route) ───────────────────────────

export interface GenerationResult {
  generationId: string
  designs: DesignOutput[]
  creditsRemaining: number
}

export interface DesignOutput {
  id: string
  imageUrl: string
  title: string
  description: string
  style: string
}
