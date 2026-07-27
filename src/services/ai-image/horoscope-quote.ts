/**
 * Horoscope Quote Generator
 *
 * Generates a short, positive-only, personalized quote/wish for the cake
 * being designed. Always runs — it is NOT gated on a zodiac sign being
 * present: if a sign is given, the quote leans on that sign's horoscope
 * traits; if not, it infers a fitting upbeat sentiment from the occasion,
 * style, and the customer's own prompt instead. If a real age is known
 * (customer gave their actual birthdate, not the seasonal fallback sign),
 * the tone is adapted to suit that age — playful for a child, warmer/more
 * mature for an adult — without necessarily stating the number outright.
 *
 * Uses a real LLM call (Anthropic Claude Haiku) rather than static
 * per-sign templates, so it's genuinely fresh each time instead of
 * repeating the same line for every Aries.
 *
 * Decorative content shown alongside the generated designs — a failure
 * here must never break the actual image generation, so every call site
 * should treat a null return as "skip the quote" and continue normally.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
const MAX_TOKENS = 100

export interface HoroscopeQuoteInput {
  /** Zodiac sign — optional; when absent, base the quote on occasion/style/prompt instead */
  sign?: string
  /** Real age from an actual birthdate — omit entirely when using the seasonal-fallback sign */
  age?: number
  occasion?: string
  style?: string
  prompt?: string
}

export async function generateHoroscopeQuote(
  input: HoroscopeQuoteInput
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn("[Horoscope Quote] ANTHROPIC_API_KEY is not set — skipping quote")
    return null
  }

  const { sign, age, occasion, style, prompt } = input

  const contextLines = [
    sign ? `Zodiac sign: ${sign}` : null,
    typeof age === "number" ? `Age: ${age}` : null,
    occasion ? `Occasion: ${occasion}` : null,
    style ? `Cake style: ${style}` : null,
    prompt ? `Their cake design idea: ${prompt}` : null,
  ].filter(Boolean)

  try {
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
        system:
          "You write a single short quote or wish (1-2 sentences, no more than 220 characters) for a " +
          "cake-design app. Always warm and positive — never mention anything negative, cautionary, or " +
          "uncertain. If a zodiac sign is given, weave in that sign's positive horoscope traits. If no " +
          "sign is given, infer a fitting upbeat sentiment instead from the occasion, cake style, and " +
          "the customer's own design idea. If an age is given, adapt the tone to suit it — playful and " +
          "fun for a child, warmer and more mature for an adult — without necessarily stating the number " +
          "itself. Naturally tie everything to the occasion and cake design. No hashtags, no emoji, no " +
          "quotation marks, no preamble — output only the quote itself.",
        messages: [{ role: "user", content: contextLines.join("\n") || "No further context given." }],
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      console.error(`[Horoscope Quote] Anthropic API error: ${response.status} ${body}`)
      return null
    }

    const data = await response.json()
    const text = data?.content?.[0]?.text?.trim()
    return text || null
  } catch (error) {
    console.error("[Horoscope Quote] Failed to generate:", error)
    return null
  }
}
