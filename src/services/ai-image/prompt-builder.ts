/**
 * Cake Prompt Builder
 *
 * Takes user inputs (prompt, style, occasion, flavor, zodiac) and constructs
 * an optimized prompt for AI image generation.
 *
 * This is the cake-specialized layer. All cake domain knowledge lives here.
 * The provider layer knows nothing about cakes — it just receives a string.
 */

import { GenerationRequest } from "./types"

// ─── Style Modifiers ─────────────────────────────────────────────────────────

const STYLE_MODIFIERS: Record<string, string> = {
  Realistic:
    "photorealistic, professional bakery photography, studio lighting, sharp focus, high detail, food photography",
  Cartoon:
    "cartoon style, playful illustration, vibrant colors, fun whimsical design, clean lines, children's book illustration style",
  Luxury:
    "luxury premium cake, gold leaf accents, elegant sophisticated design, high-end patisserie, editorial food photography, dramatic lighting",
  Minimal:
    "minimalist design, clean lines, simple elegant, modern aesthetic, negative space, subtle textures, muted tones",
  "3D Sculpted":
    "3D sculpted fondant cake, gravity-defying design, intricate sculpted details, professional cake artistry, competition-level decoration",
  Wedding:
    "elegant wedding cake, romantic floral details, tiered white cake, soft lighting, bridal aesthetic, delicate sugar flowers",
  Kids:
    "fun colorful kids birthday cake, bright vibrant colors, playful theme, cartoon characters, fondant decorations, party atmosphere",
}

// ─── Occasion Context ────────────────────────────────────────────────────────

const OCCASION_CONTEXT: Record<string, string> = {
  Birthday:
    "birthday celebration cake, festive, joyful, celebratory mood",
  Anniversary:
    "romantic anniversary cake, love theme, elegant couple celebration",
  Wedding:
    "wedding ceremony cake, bridal elegance, romantic, grand celebration",
  Festival:
    "festive celebration cake, cultural vibrancy, seasonal colors, traditional motifs",
  Kids:
    "children's party cake, fun playful, bright colors, exciting theme for young kids",
  Special:
    "special occasion cake, unique memorable design, personalized celebration",
}

// ─── Flavor Visual Hints ─────────────────────────────────────────────────────

const FLAVOR_VISUALS: Record<string, string> = {
  Chocolate:
    "rich dark chocolate tones, chocolate ganache drip, cocoa-colored layers",
  Vanilla:
    "creamy white vanilla buttercream, light ivory tones, classic elegance",
  "Red Velvet":
    "deep red velvet layers visible, cream cheese frosting, red and white contrast",
  Strawberry:
    "pink strawberry tones, fresh strawberry decorations, soft pink frosting",
  Butterscotch:
    "warm golden butterscotch tones, caramel drip, amber colored accents",
  "Salted Caramel":
    "rich caramel drizzle, golden brown tones, sea salt crystals on top, warm amber",
  Mango:
    "tropical mango yellow, fresh mango slices, vibrant yellow-orange tones",
  Blueberry:
    "deep purple-blue tones, fresh blueberry decorations, indigo accents",
  Lemon:
    "bright citrus yellow, lemon zest garnish, fresh light appearance",
}

// ─── Base System Prompt ──────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = [
  "A beautiful professionally made cake",
  "displayed on a clean elegant surface",
  "bakery product photography",
  "no people in frame",
  "no text or writing on the image",
  "centered composition",
  "soft natural lighting",
  "high resolution detailed",
].join(", ")

// ─── Builder Function ────────────────────────────────────────────────────────

/**
 * Builds an optimized prompt for cake image generation.
 *
 * Combines:
 * - User's free-text description
 * - Style modifiers (photorealistic, cartoon, luxury, etc.)
 * - Occasion context (birthday, wedding, etc.)
 * - Flavor visual hints (chocolate tones, pink strawberry, etc.)
 * - Zodiac influence (optional)
 * - Base system prompt (professional cake photography)
 *
 * @param request - The generation request from the user
 * @returns Fully constructed prompt string ready for the AI provider
 */
export function buildCakePrompt(request: GenerationRequest): string {
  const parts: string[] = []

  // 1. Base system prompt
  parts.push(BASE_SYSTEM_PROMPT)

  // 2. User's description (the most important part)
  if (request.prompt && request.prompt.trim()) {
    parts.push(request.prompt.trim())
  }

  // 3. Style modifier
  const styleModifier = STYLE_MODIFIERS[request.style]
  if (styleModifier) {
    parts.push(styleModifier)
  }

  // 4. Occasion context
  const occasionContext = OCCASION_CONTEXT[request.occasion]
  if (occasionContext) {
    parts.push(occasionContext)
  }

  // 5. Flavor visual hints
  const flavorVisual = FLAVOR_VISUALS[request.flavor]
  if (flavorVisual) {
    parts.push(flavorVisual)
  }

  // 6. Zodiac influence (optional)
  if (request.zodiacInfluence && request.zodiacInfluence.suggestion) {
    parts.push(request.zodiacInfluence.suggestion)
  }

  // 7. Quality boosters
  parts.push("8k resolution, masterpiece quality, award-winning food photography")

  return parts.join(", ")
}

/**
 * Generates a short title for a design based on the request.
 * Used when the AI doesn't provide its own title.
 */
export function generateDesignTitle(request: GenerationRequest, index: number): string {
  const titleParts: string[] = []

  if (request.style) titleParts.push(request.style)
  if (request.occasion) titleParts.push(request.occasion)

  const base = titleParts.length > 0 ? titleParts.join(" ") : "Custom"
  const suffix = ["Dream", "Delight", "Creation", "Masterpiece", "Vision"][index % 5]

  return `${base} ${suffix}`
}

/**
 * Generates a short description for a design based on the request.
 */
export function generateDesignDescription(request: GenerationRequest, index: number): string {
  const parts: string[] = []

  if (request.style) parts.push(`${request.style} style`)
  if (request.flavor && request.flavor !== "Vanilla") parts.push(`${request.flavor} flavored`)
  if (request.occasion) parts.push(`for ${request.occasion}`)
  if (request.zodiacInfluence) parts.push(`with ${request.zodiacInfluence.sign} influence`)

  const variation = ["Concept A", "Concept B", "Concept C"][index % 3]

  return parts.length > 0
    ? `${variation} — ${parts.join(", ")}`
    : `${variation} — AI generated cake design`
}
