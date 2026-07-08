/**
 * Replicate Provider
 *
 * Implements the ImageProvider interface using Replicate's API.
 * Supports any model hosted on Replicate (FLUX.1, SDXL, etc.)
 *
 * Flow:
 *   1. POST to create a prediction
 *   2. Poll until prediction completes (or use webhook in future)
 *   3. Return image URLs
 */

import { ImageProvider, GenerateOptions, GeneratedImage } from "../types"

const REPLICATE_API_BASE = "https://api.replicate.com/v1"
const POLL_INTERVAL_MS = 2000
const MAX_POLL_ATTEMPTS = 60 // 60 * 2s = 120s max wait

interface ReplicatePrediction {
  id: string
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled"
  output: string | string[] | null
  error: string | null
  urls: {
    get: string
    cancel: string
  }
}

export class ReplicateProvider implements ImageProvider {
  readonly name = "replicate"
  readonly model: string
  private apiToken: string

  constructor(apiToken: string, model: string) {
    this.apiToken = apiToken
    this.model = model
  }

  async generate(prompt: string, options: GenerateOptions): Promise<GeneratedImage[]> {
    const images: GeneratedImage[] = []

    // FLUX models generate one image per prediction
    // So we run multiple predictions in parallel for imageCount > 1
    const predictions = await Promise.all(
      Array.from({ length: options.imageCount }, (_, i) =>
        this.createAndWaitPrediction(prompt, options, i)
      )
    )

    for (const prediction of predictions) {
      if (prediction.status === "failed") {
        console.error(`[Replicate] Prediction failed:`, prediction.error)
        continue
      }

      if (prediction.output) {
        const urls = Array.isArray(prediction.output)
          ? prediction.output
          : [prediction.output]

        for (const url of urls) {
          if (typeof url === "string" && url.startsWith("http")) {
            images.push({ url, index: images.length })
          }
        }
      }
    }

    if (images.length === 0) {
      throw new Error(
        `[Replicate] All predictions failed. Last error: ${predictions[predictions.length - 1]?.error || "unknown"}`
      )
    }

    return images
  }

  // ─── Private methods ────────────────────────────────────────────────────────

  private async createAndWaitPrediction(
    prompt: string,
    options: GenerateOptions,
    index: number
  ): Promise<ReplicatePrediction> {
    const prediction = await this.createPrediction(prompt, options, index)
    return this.pollPrediction(prediction.urls.get)
  }

  private async createPrediction(
    prompt: string,
    options: GenerateOptions,
    index: number
  ): Promise<ReplicatePrediction> {
    const input = this.buildInput(prompt, options, index)

    const response = await fetch(`${REPLICATE_API_BASE}/models/${this.model}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Prefer: "wait", // Try to get synchronous response (up to 60s)
      },
      body: JSON.stringify({ input }),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "")
      throw new Error(
        `[Replicate] Failed to create prediction: ${response.status} ${response.statusText}. ${errorBody}`
      )
    }

    const prediction: ReplicatePrediction = await response.json()

    // If "Prefer: wait" worked, prediction might already be complete
    if (prediction.status === "succeeded" || prediction.status === "failed") {
      return prediction
    }

    return prediction
  }

  private async pollPrediction(getUrl: string): Promise<ReplicatePrediction> {
    let attempts = 0

    while (attempts < MAX_POLL_ATTEMPTS) {
      const response = await fetch(getUrl, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      })

      if (!response.ok) {
        throw new Error(`[Replicate] Failed to poll prediction: ${response.status}`)
      }

      const prediction: ReplicatePrediction = await response.json()

      if (prediction.status === "succeeded" || prediction.status === "failed" || prediction.status === "canceled") {
        return prediction
      }

      // Still processing — wait and retry
      await this.sleep(POLL_INTERVAL_MS)
      attempts++
    }

    throw new Error(`[Replicate] Prediction timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`)
  }

  private buildInput(prompt: string, options: GenerateOptions, index: number): Record<string, unknown> {
    const modelLower = this.model.toLowerCase()

    // FLUX models
    if (modelLower.includes("flux")) {
      return {
        prompt,
        num_outputs: 1,
        aspect_ratio: options.aspectRatio || "1:1",
        output_format: "png",
        output_quality: options.quality === "high" ? 90 : 75,
        // Add slight seed variation per image in batch for diversity
        ...(index > 0 ? { seed: Math.floor(Math.random() * 2147483647) } : {}),
      }
    }

    // SDXL models
    if (modelLower.includes("sdxl") || modelLower.includes("stable-diffusion")) {
      return {
        prompt,
        width: options.width,
        height: options.height,
        num_outputs: 1,
        num_inference_steps: options.quality === "high" ? 50 : 30,
        guidance_scale: 7.5,
        negative_prompt: "blurry, low quality, distorted, deformed, ugly, bad anatomy, watermark, text overlay, signature",
        ...(index > 0 ? { seed: Math.floor(Math.random() * 2147483647) } : {}),
      }
    }

    // Generic fallback
    return {
      prompt,
      width: options.width,
      height: options.height,
      num_outputs: 1,
      ...(index > 0 ? { seed: Math.floor(Math.random() * 2147483647) } : {}),
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
