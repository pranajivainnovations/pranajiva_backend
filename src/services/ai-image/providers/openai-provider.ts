/**
 * OpenAI Image Provider
 *
 * Implements the ImageProvider interface using OpenAI's Images API.
 * The specific model is configurable (AI_IMAGE_MODEL env var) — this class
 * branches its request shape on the model name so switching between
 * gpt-image-1, dall-e-3, or dall-e-2 is a config change, not a code change.
 *
 * Model differences that matter here:
 *   - gpt-image-1: accepts n up to 10 in a single call, quality is
 *     low/medium/high/auto, always returns base64 (no url response format).
 *   - dall-e-3: only accepts n=1 per call — multiple images need sequential
 *     requests — quality is standard/hd, supports response_format: "url".
 *   - dall-e-2: accepts n up to 10, supports response_format: "url".
 */

import { ImageProvider, GenerateOptions, GeneratedImage } from "../types"

const OPENAI_API_BASE = "https://api.openai.com/v1"

interface OpenAIImageDatum {
  b64_json?: string
  url?: string
}

interface OpenAIImageResponse {
  data: OpenAIImageDatum[]
}

export class OpenAIProvider implements ImageProvider {
  readonly name = "openai"
  readonly model: string
  private apiKey: string

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey
    this.model = model
  }

  async generate(prompt: string, options: GenerateOptions): Promise<GeneratedImage[]> {
    const requestedCount = Math.max(1, options.imageCount || 1)

    if (this.model.toLowerCase().includes("dall-e-3")) {
      // dall-e-3 only accepts n=1 per request — loop sequentially, same
      // pattern the Replicate provider uses for models without native batching.
      const images: GeneratedImage[] = []
      for (let i = 0; i < requestedCount; i++) {
        try {
          const urls = await this.requestImages(prompt, options, 1)
          for (const url of urls) images.push({ url, index: images.length })
        } catch (err) {
          console.error(`[OpenAI Image] dall-e-3 request ${i + 1}/${requestedCount} failed:`, err)
          if (i === 0) throw err
        }
      }
      if (images.length === 0) {
        throw new Error(`[OpenAI Image] All ${requestedCount} dall-e-3 requests failed`)
      }
      return images
    }

    const urls = await this.requestImages(prompt, options, requestedCount)
    if (urls.length === 0) {
      throw new Error("[OpenAI Image] Response contained no usable images")
    }
    return urls.map((url, index) => ({ url, index }))
  }

  // ─── Private methods ────────────────────────────────────────────────────────

  private async requestImages(prompt: string, options: GenerateOptions, n: number): Promise<string[]> {
    const body = this.buildRequestBody(prompt, options, n)

    const response = await fetch(`${OPENAI_API_BASE}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "")
      throw new Error(
        `[OpenAI Image] Request failed: ${response.status} ${response.statusText}. ${errorBody}`
      )
    }

    const result: OpenAIImageResponse = await response.json()

    return result.data
      .map((datum) => datum.url || (datum.b64_json ? `data:image/png;base64,${datum.b64_json}` : ""))
      .filter((url): url is string => Boolean(url))
  }

  private buildRequestBody(prompt: string, options: GenerateOptions, n: number): Record<string, unknown> {
    const modelLower = this.model.toLowerCase()

    if (modelLower.includes("gpt-image")) {
      return {
        model: this.model,
        prompt,
        n,
        size: this.mapSize(options),
        quality: options.quality === "high" ? "high" : "medium",
      }
    }

    if (modelLower.includes("dall-e-3")) {
      return {
        model: this.model,
        prompt,
        n: 1,
        size: this.mapSize(options),
        quality: options.quality === "high" ? "hd" : "standard",
        response_format: "url",
      }
    }

    // dall-e-2 or any other/future model — safe generic shape
    return {
      model: this.model,
      prompt,
      n,
      size: this.mapSize(options),
      response_format: "url",
    }
  }

  /** OpenAI image models take a fixed size string, not arbitrary width/height. */
  private mapSize(options: GenerateOptions): string {
    if (!options.aspectRatio || options.aspectRatio === "1:1") return "1024x1024"
    if (options.width && options.height && options.width !== options.height) {
      return options.width > options.height ? "1536x1024" : "1024x1536"
    }
    return "1024x1024"
  }
}
