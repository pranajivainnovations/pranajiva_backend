/**
 * Cake Design Elaborator — "Understanding" stage
 *
 * Raw user prompt (often short, or full of abstract context like place
 * names, weather, mood, age) → structured CakeDesignSpecification.
 *
 * This is deliberately the ONLY place that talks to an LLM for design intent.
 * It never touches image generation and never returns a prompt string — the
 * prompt-builder compiler does that, deterministically, from the object this
 * returns. That split is what makes the compiled prompt inspectable, capped
 * (max 4 secondary elements — no overcrowding), and swappable to a different
 * image provider without re-deriving any of this.
 *
 * Failure here (missing key, bad JSON, network error) falls back to a
 * minimal spec built from the raw fields alone — it must never block or
 * degrade image generation, only lose the "elaboration" on top of it.
 */

export interface ElaborationInput {
  prompt: string
  occasion?: string
  style?: string
  flavor?: string
  age?: number
  recipientName?: string
  zodiacSign?: string
  /** Inspiration only — the elaborator may weave this into secondaryElements if it fits, never mandatory */
  zodiacSuggestion?: string
  /** Already decided by the customer elsewhere in the form — context only, never to be restated or contradicted */
  tiers?: string
  shape?: string
  weight?: string
  /** If the customer already typed an explicit on-cake message, personalizedText must stay empty to avoid competing text instructions */
  cakeMessage?: string
}

import { CakeDesignSpecification } from "./types"

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
const MAX_TOKENS = 600
const MAX_SECONDARY_ELEMENTS = 4

// ─── Age bands — design language by recipient age, not a specific theme ──────

const AGE_BANDS: Array<{ max: number; language: string }> = [
  { max: 5, language: "playful, colorful, cartoon-friendly, cute — bright and whimsical" },
  { max: 9, language: "playful, themed, colorful, character-inspired fun" },
  { max: 12, language: "modern, creative, youthful — not babyish" },
  { max: 17, language: "sophisticated, trendy, elegant, youthful, social-media-friendly — avoid childish styling" },
  { max: Infinity, language: "mature, sophisticated, premium" },
]

function ageDesignLanguage(age?: number): string | undefined {
  if (typeof age !== "number" || Number.isNaN(age)) return undefined
  return AGE_BANDS.find((b) => age <= b.max)?.language
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert cake designer. A customer has described what they want, possibly \
with abstract or indirect context — place names, weather, mood, biographical detail, occasions — that has \
no direct visual form on its own. Your job is to interpret that context into a small, focused set of \
CONCRETE visual cake-decoration ideas, and return them as JSON matching exactly this shape:

{
  "primaryConcept": string,       // ONE sentence: the single dominant visual idea for the cake
  "secondaryElements": string[],  // 2-4 concrete supporting visual details (colors, textures, toppers, motifs). Never more than 4.
  "colorAccents": string[],       // optional extra colors suggested by context (place/season/mood), may be empty
  "personalizedText": string,     // e.g. "Kaesha, 13" — omit (empty string) if no name/age is known
  "mood": string[],               // 2-3 mood words
  "culturalNote": string          // ONE subtle, non-literal sentence tying in location/culture — empty string if nothing explicit was given
}

Rules:
- Prioritize: 1 PRIMARY concept, 2-4 SECONDARY elements TOTAL. This total INCLUDES any zodiac motif you choose to \
weave in — it does not get its own separate budget. Do not list many unrelated ideas just because the customer \
mentioned many things — pick the most visually relevant and keep it focused. Overcrowding is a failure.
- Cake structure (tier count, shape, size) is decided elsewhere and given to you only as fixed context. NEVER \
mention, restate, or invent a tier count, cake shape, or size in your response — that would contradict the \
final prompt. Focus only on decoration, color, motif, and mood.
- Translate context, don't just repeat it: a place name becomes recognizable local scenery/architecture in \
fondant; weather becomes literal decoration (rain becomes sugar raindrops and grey fondant clouds); a river \
becomes a flowing icing/fondant water motif.
- Never invent specific facts the customer didn't give: no specific temple, specific religious symbol, specific \
family tradition, or specific favorite color that wasn't mentioned or clearly implied. If a cultural reference \
isn't explicit, keep culturalNote subtle or leave it empty.
- Age should influence design language (sophistication, tone) — never force a literal theme from it (e.g. a \
13-year-old must NOT default to a childish pink cake just because of age).
- The customer's flavor choice often has an obvious color association (chocolate → brown, red velvet → red/white, \
strawberry → pink, lemon → yellow, etc.). Reflect that ONLY if it's compatible with the primary concept's own \
color story. If it would clash with the concept's colors (e.g. red velvet's red/white look fighting an otherwise \
forest-green nature theme), do not force it into colorAccents — either omit it or reflect it subtly through an \
interior cross-section detail in secondaryElements instead of a competing exterior color. The design's own \
color story always wins over a flavor's default color.
- If a zodiac sign is given, you MAY weave a subtle motif from its suggested imagery into secondaryElements ONLY \
if it fits the primary concept thematically (e.g. skip a "crown topper" suggestion on a nature/river-themed cake) \
— it is optional inspiration, never a mandatory addition, and never worth exceeding the secondary-element cap for.
- If an explicit on-cake message is already given, leave personalizedText as an empty string — do not create a \
second, competing piece of on-cake text.
- Preserve every concrete detail the customer explicitly gave (names, exact colors, shapes, objects) — reflect \
them in the specification, never drop or contradict them.
- Output ONLY the JSON object. No markdown fences, no commentary, no preamble.`

function buildUserMessage(input: ElaborationInput, ageLanguageHint?: string): string {
  const lines = [
    `Customer's request: ${input.prompt.trim()}`,
    input.occasion ? `Occasion: ${input.occasion}` : null,
    input.style ? `Style: ${input.style}` : null,
    input.flavor ? `Flavor: ${input.flavor}` : null,
    input.recipientName ? `Recipient name: ${input.recipientName}` : null,
    typeof input.age === "number" ? `Recipient age: ${input.age}` : null,
    ageLanguageHint ? `Age-appropriate design language to lean on: ${ageLanguageHint}` : null,
    "--- Already fixed elsewhere, context only — do not restate or contradict ---",
    input.tiers ? `Tier count: ${input.tiers}` : null,
    input.shape ? `Cake shape: ${input.shape}` : null,
    input.weight ? `Size: ${input.weight}` : null,
    input.cakeMessage ? `On-cake message (already decided, leave personalizedText empty): "${input.cakeMessage}"` : null,
    input.zodiacSign
      ? `Zodiac sign: ${input.zodiacSign}${input.zodiacSuggestion ? ` (optional motif inspiration: ${input.zodiacSuggestion})` : ""}`
      : null,
  ]
  return lines.filter(Boolean).join("\n")
}

function parseSpecification(text: string): CakeDesignSpecification | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (!parsed || typeof parsed.primaryConcept !== "string" || !parsed.primaryConcept.trim()) {
      return null
    }
    return {
      primaryConcept: parsed.primaryConcept.trim(),
      secondaryElements: Array.isArray(parsed.secondaryElements)
        ? parsed.secondaryElements.filter((s: unknown) => typeof s === "string" && s.trim()).slice(0, MAX_SECONDARY_ELEMENTS)
        : [],
      colorAccents: Array.isArray(parsed.colorAccents)
        ? parsed.colorAccents.filter((s: unknown) => typeof s === "string" && s.trim())
        : undefined,
      personalizedText:
        typeof parsed.personalizedText === "string" && parsed.personalizedText.trim()
          ? parsed.personalizedText.trim()
          : undefined,
      mood: Array.isArray(parsed.mood)
        ? parsed.mood.filter((s: unknown) => typeof s === "string" && s.trim())
        : [],
      culturalNote:
        typeof parsed.culturalNote === "string" && parsed.culturalNote.trim()
          ? parsed.culturalNote.trim()
          : undefined,
    }
  } catch {
    return null
  }
}

async function callAnthropic(system: string, userMessage: string, apiKey: string): Promise<string | null> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    console.error(`[Cake Design Elaborator] Anthropic API error: ${response.status} ${body}`)
    return null
  }

  const data = await response.json()
  return data?.content?.[0]?.text ?? null
}

/** Minimal spec built with no LLM call — used whenever elaboration is unavailable or fails twice. */
function fallbackSpecification(input: ElaborationInput): CakeDesignSpecification {
  return {
    primaryConcept: input.prompt.trim() || `A cake for the occasion${input.occasion ? `: ${input.occasion}` : ""}`,
    secondaryElements: [],
    mood: [],
    ageDesignLanguage: ageDesignLanguage(input.age),
    personalizedText: input.cakeMessage
      ? undefined
      : input.recipientName && typeof input.age === "number"
      ? `${input.recipientName}, ${input.age}`
      : input.recipientName || undefined,
  }
}

export async function elaborateCakeDesign(input: ElaborationInput): Promise<CakeDesignSpecification> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const ageLanguage = ageDesignLanguage(input.age)

  if (!apiKey || !input.prompt.trim()) {
    return fallbackSpecification(input)
  }

  const userMessage = buildUserMessage(input, ageLanguage)

  try {
    const firstText = await callAnthropic(SYSTEM_PROMPT, userMessage, apiKey)
    let spec = firstText ? parseSpecification(firstText) : null

    if (!spec) {
      // Retry once with an explicit correction nudge — never silently give up
      // on a single malformed response before falling back.
      const retryText = await callAnthropic(
        SYSTEM_PROMPT,
        `${userMessage}\n\n(Your previous response was not valid JSON matching the required shape. Return ONLY the JSON object this time.)`,
        apiKey
      )
      spec = retryText ? parseSpecification(retryText) : null
    }

    if (!spec) {
      console.error("[Cake Design Elaborator] Failed to get valid JSON after retry, using fallback spec")
      return fallbackSpecification(input)
    }

    if (ageLanguage && !spec.ageDesignLanguage) {
      spec.ageDesignLanguage = ageLanguage
    }
    return spec
  } catch (error) {
    console.error("[Cake Design Elaborator] Failed, falling back to minimal spec:", error)
    return fallbackSpecification(input)
  }
}
