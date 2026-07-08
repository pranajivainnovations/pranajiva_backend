/**
 * Tag Extractor
 *
 * Derives searchable tags from user prompt + selected attributes.
 * These tags power the recommendation engine and search functionality.
 *
 * No AI needed — simple keyword extraction + attribute mapping.
 * Tags are stored in the cake_designs table as TEXT[] with a GIN index.
 */

import { GenerationRequest } from "./types"

// ─── Cake-specific keywords to detect in prompts ─────────────────────────────

const TIER_PATTERNS: [RegExp, string][] = [
  [/\b(single|1)\s*tier/i, "1-tier"],
  [/\b(two|2)\s*tier/i, "2-tier"],
  [/\b(three|3)\s*tier/i, "3-tier"],
  [/\b(four|4)\s*tier/i, "4-tier"],
  [/\b(five|5)\s*tier/i, "5-tier"],
  [/\bmulti[\s-]?tier/i, "multi-tier"],
]

const SHAPE_KEYWORDS: string[] = [
  "round", "square", "heart", "oval", "hexagonal", "rectangular",
  "tall", "flat", "sculpted", "geometric",
]

const DECORATION_KEYWORDS: string[] = [
  "floral", "flowers", "roses", "sunflower", "lily", "orchid", "daisy",
  "gold", "silver", "metallic", "shimmer", "glitter", "sparkle",
  "drip", "ganache", "buttercream", "fondant", "cream",
  "pearl", "beads", "ribbon", "lace", "ruffle",
  "topper", "crown", "tiara", "figurine",
  "sprinkles", "confetti", "rainbow",
  "marble", "geode", "watercolor", "ombre", "gradient",
  "naked", "semi-naked", "rustic",
  "mirror glaze", "galaxy", "nebula", "cosmic",
  "tropical", "palm", "monstera", "pineapple",
  "butterfly", "bird", "feather",
  "vintage", "retro", "modern", "minimalist",
  "piping", "hand-painted", "brush-stroke",
]

const COLOR_KEYWORDS: string[] = [
  "pink", "red", "blue", "purple", "violet", "lavender",
  "green", "sage", "mint", "teal", "turquoise",
  "yellow", "orange", "peach", "coral",
  "white", "ivory", "cream", "beige",
  "black", "dark", "navy", "burgundy", "maroon",
  "pastel", "neon", "bright", "muted", "earthy",
  "rose gold", "champagne", "blush",
]

const THEME_KEYWORDS: string[] = [
  "unicorn", "princess", "prince", "castle", "fairy",
  "superhero", "spiderman", "batman", "avengers",
  "disney", "frozen", "elsa", "mickey", "minnie",
  "minecraft", "gaming", "car", "truck", "dinosaur",
  "space", "astronaut", "rocket", "planet",
  "ocean", "mermaid", "beach", "nautical",
  "jungle", "safari", "animal", "zoo",
  "sports", "football", "cricket", "basketball",
  "music", "guitar", "piano",
  "travel", "map", "adventure",
  "book", "library", "graduation",
]

// ─── Extractor Function ──────────────────────────────────────────────────────

/**
 * Extracts searchable tags from a generation request.
 *
 * Sources:
 * 1. Selected attributes (style, occasion, flavor) — always included
 * 2. Prompt keyword matching — detects tiers, shapes, decorations, colors, themes
 * 3. Zodiac sign — if provided
 *
 * @param request - The generation request
 * @returns Array of lowercase, deduplicated tags
 */
export function extractTags(request: GenerationRequest): string[] {
  const tags = new Set<string>()

  // 1. Always include selected attributes
  if (request.style) tags.add(request.style.toLowerCase())
  if (request.occasion) tags.add(request.occasion.toLowerCase())
  if (request.flavor) tags.add(request.flavor.toLowerCase())
  if (request.zodiacInfluence?.sign) tags.add(request.zodiacInfluence.sign.toLowerCase())

  // 2. Extract from prompt
  const prompt = (request.prompt || "").toLowerCase()

  // Tier detection
  for (const [pattern, tag] of TIER_PATTERNS) {
    if (pattern.test(prompt)) {
      tags.add(tag)
      break // only one tier tag
    }
  }

  // Shape keywords
  for (const keyword of SHAPE_KEYWORDS) {
    if (prompt.includes(keyword)) {
      tags.add(keyword)
    }
  }

  // Decoration keywords
  for (const keyword of DECORATION_KEYWORDS) {
    if (prompt.includes(keyword)) {
      tags.add(keyword)
    }
  }

  // Color keywords
  for (const keyword of COLOR_KEYWORDS) {
    if (prompt.includes(keyword)) {
      tags.add(keyword)
    }
  }

  // Theme keywords
  for (const keyword of THEME_KEYWORDS) {
    if (prompt.includes(keyword)) {
      tags.add(keyword)
    }
  }

  return Array.from(tags)
}
