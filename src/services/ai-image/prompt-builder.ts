/**
 * Cake Prompt Builder
 *
 * Takes user inputs (prompt, style, occasion, flavor, weight, tiers, color,
 * message, zodiac) and constructs an optimized prompt for AI image generation.
 *
 * This is the cake-specialized layer. All cake domain knowledge lives here.
 * The provider layer knows nothing about cakes — it just receives a string.
 */

import { GenerationRequest, CakeDesignSpecification } from "./types"

// ─── Style Modifiers ─────────────────────────────────────────────────────────

const STYLE_MODIFIERS: Record<string, string> = {
  Realistic:
    "This should look like genuine, professional bakery photography — photorealistic textures, crisp studio lighting, and sharp, high-detail focus throughout, exactly as a high-end bakery would photograph it for its own portfolio",
  Cartoon:
    "Render it as playful cartoon-style illustration — vibrant colors, whimsical fun shapes, and clean bold linework, closer to a children's book illustration than a photograph",
  Luxury:
    "This is a luxury, premium patisserie creation — gold leaf accents, sophisticated and elegant detailing, and the dramatic, editorial food photography look of a high-end celebration",
  Minimal:
    "Keep the design minimalist and modern — clean simple lines, generous negative space, subtle understated textures, and a muted, calm color story",
  "3D Sculpted":
    "This is a 3D sculpted fondant showpiece — gravity-defying shapes, intricate hand-sculpted detail, and the level of craftsmanship expected from a competition-winning cake artist",
  Wedding:
    "Style it as an elegant wedding cake — romantic floral details, soft bridal lighting, delicate sugar flowers, and tiered white elegance throughout",
  Kids:
    "Make it a fun, colorful kids' birthday cake — bright vibrant colors, a playful party atmosphere, and cheerful fondant decorations that feel exciting for a child",
}

// ─── Occasion Context ────────────────────────────────────────────────────────

const OCCASION_CONTEXT: Record<string, string> = {
  Birthday: "a festive, joyful birthday-celebration mood",
  Anniversary: "a romantic anniversary mood celebrating a couple's love",
  Wedding: "the elegance and grandeur of a wedding ceremony",
  Festival: "vibrant festive cultural energy, with seasonal colors and traditional motifs",
  Kids: "a fun, bright, playful children's-party mood",
  Special: "a unique, memorable, personalized special-occasion feel",
}

// ─── Flavor Visual Hints ─────────────────────────────────────────────────────

const FLAVOR_VISUALS: Record<string, string> = {
  Chocolate: "rich, dark chocolate tones with glossy ganache drips and cocoa-colored layers",
  Vanilla: "creamy white vanilla buttercream in soft ivory tones with classic elegance",
  "Red Velvet": "deep red velvet layers peeking through cream cheese frosting, a striking red-and-white contrast",
  Strawberry: "soft pink strawberry tones with fresh strawberry garnish",
  Butterscotch: "warm golden butterscotch tones with a rich caramel drip",
  "Salted Caramel": "rich caramel drizzle over golden-brown tones, finished with a few flecks of sea salt",
  Mango: "vibrant tropical mango-yellow tones with fresh mango slice garnish",
  Blueberry: "deep indigo-blue tones with fresh blueberry accents",
  Lemon: "bright citrus-yellow tones with a fresh lemon zest garnish",
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

// ─── Shape Constraints ───────────────────────────────────────────────────────

const SHAPE_CONSTRAINTS: Record<string, string> = {
  Round: "round cake shape, classic circular tiers",
  Square: "square cake shape, clean geometric edges",
  Heart: "heart-shaped cake, romantic curved silhouette",
  Oval: "oval-shaped cake, elongated rounded silhouette",
}

// ─── Color Palette ───────────────────────────────────────────────────────────

const COLOR_PALETTES: Record<string, string> = {
  Pink: "a dominant pink palette — pink frosting, pink roses, and soft blush-pink tones throughout",
  Blue: "a dominant blue palette — blue frosting and accents ranging from sky blue to deep navy",
  White: "an elegant all-white design — white frosting, white flowers, and pristine pearl-white accents",
  Gold: "gold woven throughout — gold leaf details, champagne-gold tones, and a luxurious metallic shimmer",
  Black: "a dramatic black design — black frosting with gold accents for a sophisticated, moody aesthetic",
  Pastel: "a soft pastel palette — gentle light pink, baby blue, mint green, and lavender in muted tones",
  Rainbow: "a vibrant rainbow of colors — multicolored layers in a bright, cheerful, fun spectrum",
  "No preference": "",
}

// ─── Builder Function ────────────────────────────────────────────────────────

/**
 * Compiles the final image-generation prompt.
 *
 * This is the DETERMINISTIC compiler stage — it never calls an LLM. It takes
 * the raw request plus the CakeDesignSpecification already produced by
 * cake-design-elaborator.ts (the "understanding" stage) and assembles them
 * into natural-language sentences in a fixed priority order:
 *
 *   1. structure (tiers/weight/shape)
 *   2. the user's own explicit words, verbatim — always the top-priority subject
 *   3. the elaborated primary concept (the LLM's interpretation of context
 *      the user's raw words didn't spell out visually)
 *   4. on-cake message (explicit customer text wins; personalized name/age
 *      text is a fallback, never an addition — two competing text asks means
 *      the model renders neither). Placed early and phrased explicitly
 *      ("legible", "spelled exactly") because on-cake text is the single most
 *      fragile thing a diffusion model renders — burying it late in a long
 *      prompt after many other visual instructions made it disappear entirely
 *      in testing. Zodiac influence is not a separate step here: it's optional
 *      inspiration folded into secondary elements (6) by the elaborator, only
 *      when it fits the theme.
 *   5. style + explicit color choice
 *   6. occasion mood (flavor's color is reconciled by the elaborator into the
 *      chosen color story above, not forced in separately — see below)
 *   7. secondary elements (capped at 4 upstream — keeps the design focused,
 *      not overcrowded)
 *   8. cultural/location note (subtle, one sentence, only if present)
 *   9. age-appropriate design language (tone, not a forced literal theme)
 *  10. mood
 *  11. quality boosters
 *
 * Written as natural-language sentences rather than a flat comma-separated
 * keyword list — FLUX (like most modern providers) uses a T5 text encoder,
 * which reads prompts as real language with grammar and emphasis, not a bag
 * of tags. A keyword-soup structure disadvantages whichever part of the
 * prompt is a full sentence, which is exactly the user's own description —
 * the one part that matters most.
 *
 * `spec` is optional so this still works standalone (e.g. tests, or if
 * elaboration is ever skipped) — in that case it just compiles the raw
 * request fields, same as before this stage existed.
 *
 * @param request - The generation request from the user
 * @param spec - The structured design specification from the elaborator
 * @returns Fully constructed prompt string ready for the AI provider
 */
export function buildCakePrompt(request: GenerationRequest, spec?: CakeDesignSpecification): string {
  const sentences: string[] = []

  // 1. Scene-setting — structure constraints folded in as descriptive clauses
  const structureClauses = [
    request.tiers ? TIER_CONSTRAINTS[request.tiers] : null,
    request.weight ? WEIGHT_CONSTRAINTS[request.weight] : null,
    request.shape ? SHAPE_CONSTRAINTS[request.shape] : null,
  ].filter(Boolean)

  sentences.push(
    [
      "A professionally photographed bakery cake",
      ...structureClauses,
      "displayed on a clean elegant surface with soft natural lighting, centered composition, no people in frame",
    ].join(", ") + "."
  )

  // 2. The user's own description — the PRIMARY subject, explicitly foregrounded
  // and directive so it isn't just another tag among the modifiers below.
  if (request.prompt && request.prompt.trim()) {
    sentences.push(`The cake's design must clearly show: ${request.prompt.trim()}.`)
  }

  // 3. The elaborated primary concept — the concrete visual translation of
  // whatever abstract/contextual info the raw prompt alone couldn't render.
  if (spec?.primaryConcept && spec.primaryConcept.trim() !== request.prompt?.trim()) {
    sentences.push(`${spec.primaryConcept.trim()}.`)
  }

  // 4. On-cake message + personalized name/age — ONE text directive only,
  // placed early and phrased explicitly for legibility (see doc comment
  // above). An explicit customer message always wins; the auto-derived
  // name/age text is a fallback for when there's no explicit message, never
  // an addition to it — two competing text instructions means the model
  // renders neither.
  if (request.cakeMessage) {
    sentences.push(
      `The cake prominently displays the words "${request.cakeMessage}" written clearly in elegant icing lettering on a smooth plaque or banner area of the cake, spelled exactly as given, legible and unmistakable.`
    )
  } else if (spec?.personalizedText && spec.personalizedText.trim()) {
    sentences.push(
      `The cake prominently displays the words "${spec.personalizedText.trim()}" written clearly in elegant icing lettering on a smooth area of the cake, legible and unmistakable.`
    )
  }

  // 5. Style + explicit color choice — full descriptive sentences, not
  // comma-separated tag fragments, so this reads as explanation rather than
  // keyword soup.
  const styleModifier = STYLE_MODIFIERS[request.style]
  if (styleModifier) {
    sentences.push(`${styleModifier}.`)
  }
  const colorClauses = [
    request.color && request.color !== "No preference" ? COLOR_PALETTES[request.color] : null,
    spec?.colorAccents && spec.colorAccents.length > 0
      ? `additional accent tones drawn from the design concept: ${spec.colorAccents.join(", ")}`
      : null,
  ].filter(Boolean)
  if (colorClauses.length > 0) {
    sentences.push(`The color story features ${colorClauses.join(", with ")}.`)
  }

  // 6. Occasion mood. Flavor's visual/color representation is intentionally
  // NOT forced in here when a spec exists — the elaborator already decided
  // whether the flavor's default color (e.g. red velvet's red/white) fits
  // the primary concept's own color story, or would clash with it (e.g.
  // against a forest-green nature theme) and should be dropped/softened
  // instead. Forcing both independently caused the model to receive two
  // contradictory color directives and arbitrarily pick one. Only fall back
  // to the static flavor-color phrase when there's no spec to reason about it.
  const occasionContext = OCCASION_CONTEXT[request.occasion]
  if (occasionContext) {
    sentences.push(`Fitting the occasion, it should carry ${occasionContext}.`)
  }
  if (!spec) {
    const flavorVisual = FLAVOR_VISUALS[request.flavor]
    if (flavorVisual) {
      sentences.push(`Its flavor is reflected visually through ${flavorVisual}.`)
    }
  }

  // 7. Secondary elements — concrete supporting details, already capped
  // upstream so the design stays focused instead of overcrowded.
  if (spec?.secondaryElements && spec.secondaryElements.length > 0) {
    sentences.push(
      `To bring the concept to life, incorporate these supporting decorative details: ${spec.secondaryElements.join("; ")}.`
    )
  }

  // 8. Cultural/location note — subtle, one sentence, only if the elaborator
  // found something explicit worth reflecting.
  if (spec?.culturalNote && spec.culturalNote.trim()) {
    sentences.push(`${spec.culturalNote.trim()}.`)
  }

  // 9. Age-appropriate design language — tone/sophistication only, never a
  // forced literal theme (e.g. a 13-year-old must not default to "childish").
  if (spec?.ageDesignLanguage && spec.ageDesignLanguage.trim()) {
    sentences.push(`The design language should feel age-appropriate for the recipient: ${spec.ageDesignLanguage.trim()}.`)
  }

  // 10. Mood
  if (spec?.mood && spec.mood.length > 0) {
    sentences.push(`The cake should evoke an overall mood of ${spec.mood.join(", ")}.`)
  }

  // 11. Quality boosters
  sentences.push("The final image should be 8k resolution, masterpiece quality, award-winning food photography.")

  return sentences.join(" ")
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
  if (request.shape) parts.push(request.shape)
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
