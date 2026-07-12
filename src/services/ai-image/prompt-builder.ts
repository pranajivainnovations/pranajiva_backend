/**
 * Cake Prompt Builder
 *
 * Takes user inputs (prompt, style, occasion, flavor, weight, tiers, color,
 * message, zodiac) and constructs an optimized prompt for AI image generation.
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

// ─── Weight/Size Constraints ─────────────────────────────────────────────────

const WEIGHT_CONSTRAINTS: Record<string, string> = {
  "0.5kg": "small mini cake, compact single tier, petite elegant design suitable for 2-4 people",
  "1kg": "small single tier cake, modest size, suitable for 6-8 people",
  "1.5kg": "medium single tier cake, generous proportions, suitable for 10-12 people",
  "2kg": "medium-large cake, can be single or two tier, suitable for 15-20 people",
  "3kg": "large cake, two tier design, grand proportions, suitable for 25-30 people",
  "4kg": "very large cake, two or three tier, impressive grand design, suitable for 35-40 people",
  "5kg": "extra large grand cake, multi-tier showpiece, spectacular design, suitable for 50+ people",
}

// ─── Tier Constraints ────────────────────────────────────────────────────────

const TIER_CONSTRAINTS: Record<string, string> = {
  "1": "single tier cake, one layer, all decoration on one level",
  "2": "two tier cake, two stacked layers of different sizes, elegant proportions",
  "3": "three tier tall cake, three stacked layers decreasing in size, grand impressive height",
  "4": "four tier towering cake, four stacked layers, spectacular tall showpiece design",
}

// ─── Color Palette ───────────────────────────────────────────────────────────

const COLOR_PALETTES: Record<string, string> = {
  Pink: "dominant pink color palette, pink frosting, pink roses, blush pink decorations, soft pink tones throughout",
  Blue: "dominant blue color palette, blue frosting, blue decorations, sky blue to navy accents",
  White: "elegant all-white design, white frosting, white flowers, pearl white accents, pristine clean look",
  Gold: "gold accents throughout, gold leaf details, champagne gold tones, metallic gold decorations, luxurious golden shimmer",
  Black: "dramatic black design, black frosting, dark elegant aesthetic, black and gold accents, sophisticated dark theme",
  Pastel: "soft pastel color palette, light pink, baby blue, mint green, lavender, gentle muted tones",
  Rainbow: "vibrant rainbow colors, multicolored layers, bright cheerful spectrum of colors, fun colorful design",
  "No preference": "",
}

// ─── Base System Prompt ──────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = [
  "A beautiful professionally made cake",
  "displayed on a clean elegant surface",
  "bakery product photography",
  "no people in frame",
  "centered composition",
  "soft natural lighting",
  "high resolution detailed",
].join(", ")

// ─── Builder Function ────────────────────────────────────────────────────────

/**
 * Builds an optimized prompt for cake image generation.
 *
 * Priority order (most important first):
 * 1. Structure constraints (tiers, weight/size) — hard physical constraints
 * 2. User's free-text description — their core vision
 * 3. Style modifier — visual treatment
 * 4. Color palette — dominant visual
 * 5. Occasion context — mood/theme
 * 6. Flavor visual hints — color undertones
 * 7. Cake message — text on cake
 * 8. Zodiac influence — optional accents
 * 9. Quality boosters
 *
 * @param request - The generation request from the user
 * @returns Fully constructed prompt string ready for the AI provider
 */
export function buildCakePrompt(request: GenerationRequest): string {
  const parts: string[] = []

  // 1. Base system prompt
  parts.push(BASE_SYSTEM_PROMPT)

  // 2. Structure constraints (MOST IMPORTANT — defines what's physically possible)
  if (request.tiers) {
    const tierConstraint = TIER_CONSTRAINTS[request.tiers]
    if (tierConstraint) parts.push(tierConstraint)
  }

  if (request.weight) {
    const weightConstraint = WEIGHT_CONSTRAINTS[request.weight]
    if (weightConstraint) parts.push(weightConstraint)
  }

  // 3. User's description (their core vision)
  if (request.prompt && request.prompt.trim()) {
    parts.push(request.prompt.trim())
  }

  // 4. Style modifier
  const styleModifier = STYLE_MODIFIERS[request.style]
  if (styleModifier) {
    parts.push(styleModifier)
  }

  // 5. Color palette (strong visual directive)
  if (request.color && request.color !== "No preference") {
    const colorPalette = COLOR_PALETTES[request.color]
    if (colorPalette) parts.push(colorPalette)
  }

  // 6. Occasion context
  const occasionContext = OCCASION_CONTEXT[request.occasion]
  if (occasionContext) {
    parts.push(occasionContext)
  }

  // 7. Flavor visual hints
  const flavorVisual = FLAVOR_VISUALS[request.flavor]
  if (flavorVisual) {
    parts.push(flavorVisual)
  }

  // 8. Cake message
  if (request.cakeMessage) {
    parts.push(`with text "${request.cakeMessage}" elegantly written on the cake`)
  }

  // 9. Zodiac influence (optional)
  if (request.zodiacInfluence && request.zodiacInfluence.suggestion) {
    parts.push(request.zodiacInfluence.suggestion)
  }

  // 10. Quality boosters
  parts.push("8k resolution, masterpiece quality, award-winning food photography")

  return parts.join(", ")
}

/**
 * Generates a short title for a design based on the request.
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
  if (request.tiers) parts.push(`${request.tiers} tier`)
  if (request.weight) parts.push(request.weight)
  if (request.flavor && request.flavor !== "Vanilla") parts.push(`${request.flavor} flavored`)
  if (request.occasion) parts.push(`for ${request.occasion}`)
  if (request.color && request.color !== "No preference") parts.push(`in ${request.color}`)
  if (request.zodiacInfluence) parts.push(`with ${request.zodiacInfluence.sign} influence`)

  const variation = ["Concept A", "Concept B", "Concept C"][index % 3]

  return parts.length > 0
    ? `${variation} — ${parts.join(", ")}`
    : `${variation} — AI generated cake design`
}
