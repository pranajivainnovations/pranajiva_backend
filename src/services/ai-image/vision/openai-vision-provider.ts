import { VisionAnalyzer, VisionAnalysisInput } from "./types"

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"
const MAX_TOKENS = 500

export class OpenAIVisionProvider implements VisionAnalyzer {
  readonly name = "openai"
  readonly model: string
  private apiKey: string

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey
    this.model = model
  }

  async analyzeImage(input: VisionAnalysisInput): Promise<string> {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: input.instructions },
              {
                type: "image_url",
                image_url: { url: `data:${input.mimeType};base64,${input.imageBuffer.toString("base64")}` },
              },
            ],
          },
        ],
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`[Vision/OpenAI] Request failed: ${response.status} ${response.statusText}. ${body}`)
    }

    const data = await response.json()
    const text = data?.choices?.[0]?.message?.content?.trim()
    if (!text) {
      throw new Error("[Vision/OpenAI] Response contained no text")
    }
    return text
  }
}
