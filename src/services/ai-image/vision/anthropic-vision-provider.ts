import { VisionAnalyzer, VisionAnalysisInput } from "./types"

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const MAX_TOKENS = 500

export class AnthropicVisionProvider implements VisionAnalyzer {
  readonly name = "anthropic"
  readonly model: string
  private apiKey: string

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey
    this.model = model
  }

  async analyzeImage(input: VisionAnalysisInput): Promise<string> {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: input.mimeType,
                  data: input.imageBuffer.toString("base64"),
                },
              },
              { type: "text", text: input.instructions },
            ],
          },
        ],
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`[Vision/Anthropic] Request failed: ${response.status} ${response.statusText}. ${body}`)
    }

    const data = await response.json()
    const text = data?.content?.[0]?.text?.trim()
    if (!text) {
      throw new Error("[Vision/Anthropic] Response contained no text")
    }
    return text
  }
}
