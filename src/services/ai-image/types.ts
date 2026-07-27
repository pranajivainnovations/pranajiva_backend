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
  provider: "replicate" | "openai" | "gemini" | "stability"
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
  shape?: string
  color?: string
  cakeMessage?: string
  zodiacInfluence?: {
    sign: string
    suggestion: string
  }
  /** Only present when the customer gave a real birthdate (not the seasonal fallback) */
  age?: number
  imageCount?: number
  /** Optional per-request provider choice (e.g. a UI model picker) — falls back to AI_IMAGE_PROVIDER env default when omitted */
  imageProvider?: string
  /** Optional per-request model choice — must be on that provider's request-allowlist (see provider-factory.ts) or it's ignored */
  imageModel?: string
  /** id of a row in ai_studio.personal_uploads — ownership is verified against customerId before it's ever read.
   * Purpose (theme reference vs. recreate-this-cake) is read from that row itself, set once at upload time —
   * not re-specified here, so the two can never disagree. */
  referenceUploadId?: string
}

// ─── Generation Result (from service to API route) ───────────────────────────

export interface GenerationResult {
  generationId: string
  designs: DesignOutput[]
  creditsRemaining: number
  /** Positive, LLM-generated horoscope-style quote — omitted if no zodiac influence was requested or generation failed */
  horoscopeQuote?: string
}

// ─── Cake Design Specification (LLM understanding → structured intermediate) ─
//
// The elaborator's job is ONLY to fill this in from the raw request. The
// prompt compiler's job is ONLY to turn this + the raw request into the
// final prompt string. Neither one invents facts the other is responsible
// for — see cake-design-elaborator.ts and prompt-builder.ts.

export interface CakeDesignSpecification {
  /** The single dominant visual idea for the cake, one concrete sentence */
  primaryConcept: string
  /** 2-4 concrete supporting visual details — never more, to avoid overcrowding the design */
  secondaryElements: string[]
  /** Additional colors suggested by context (place/season/mood) — distinct from the user's explicit color choice */
  colorAccents?: string[]
  /** e.g. "Kaesha, 13" — only set when a name and/or age is actually known */
  personalizedText?: string
  /** Short design-language phrase for the recipient's age, e.g. "youthful, modern, sophisticated — not childish" */
  ageDesignLanguage?: string
  /** 2-3 mood words */
  mood: string[]
  /** One subtle, non-literal sentence tying in location/culture — omitted entirely if nothing was explicitly relevant */
  culturalNote?: string
}

export interface DesignOutput {
  id: string
  imageUrl: string
  title: string
  description: string
  style: string
  /** The exact compiled prompt sent to the image provider — shown publicly so
   * visitors can reuse it in other tools, not just the raw customer input. */
  compiledPrompt?: string
}
