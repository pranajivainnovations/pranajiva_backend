/**
 * Gemini Image Provider
 *
 * Implements ImageProvider using Google's Generative Language API with an
 * image-capable Gemini model (default: gemini-2.5-flash-image). Unlike
 * Replicate/OpenAI's dedicated image endpoints, image generation here goes
 * through the same generateContent endpoint used for text, with
 * responseModalities: ["IMAGE"] requesting image output. Google returns the
 * image inline as base64 (inlineData), not as a hosted URL.
 *
 * The API has no native "N images per call" parameter for this modality, so
 * multiple images are requested via sequential calls — same pattern the
 * OpenAI provider uses for dall-e-3.
 */

import { ImageProvider, GenerateOptions, GeneratedImage } from "../types"

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>
}

export class GeminiProvider implements ImageProvider {
  readonly name = "gemini"
  readonly model: string
  private apiKey: string

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey
    this.model = model
  }

  async generate(prompt: string, options: GenerateOptions): Promise<GeneratedImage[]> {
    const requestedCount = Math.max(1, options.imageCount || 1)
    const images: GeneratedImage[] = []

    for (let i = 0; i < requestedCount; i++) {
      try {
        const url = await this.requestImage(prompt)
        images.push({ url, index: images.length })
      } catch (err) {
        console.error(`[Gemini Image] Request ${i + 1}/${requestedCount} failed:`, err)
        if (i === 0) throw err
      }
    }

    if (images.length === 0) {
      throw new Error(`[Gemini Image] All ${requestedCount} requests failed`)
    }

    return images
  }

  // ─── Private methods ────────────────────────────────────────────────────────

  private async requestImage(prompt: string): Promise<string> {
    const response = await fetch(`${GEMINI_API_BASE}/${this.model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "")
      throw new Error(
        `[Gemini Image] Request failed: ${response.status} ${response.statusText}. ${errorBody}`
      )
    }

    const data: GeminiResponse = await response.json()
    const parts = data.candidates?.[0]?.content?.parts || []
    const imagePart = parts.find((p) => p.inlineData?.data)

    if (!imagePart?.inlineData) {
      throw new Error("[Gemini Image] Response contained no image data")
    }

    return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`
  }
}
