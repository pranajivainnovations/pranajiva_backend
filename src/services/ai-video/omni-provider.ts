/**
 * Gemini Omni Flash video client, over REST.
 *
 * ── Why REST and not the SDK ──────────────────────────────────────────────────────────────────
 * Because that is what this codebase does. The Gemini IMAGE provider next door calls
 * generativelanguage.googleapis.com with fetch and no vendor package, and a video provider that
 * dragged in @google/genai would be a second way of talking to the same host, with its own version
 * to keep current. The guide this was built from is Python SDK code; none of it ports directly.
 *
 * ── What the SDK hides, and why it matters here ───────────────────────────────────────────────
 * The convenience field `interaction.output_video` is SDK-only. Over REST the video is an item
 * inside `steps[].content[]`, and the interaction's own `id` — not an operation name — is what a
 * continuation is anchored to. Code written from the SDK examples looks for `generated_videos[0]`
 * and finds nothing.
 *
 * ── Why there is no duration parameter ────────────────────────────────────────────────────────
 * Because the model has none. Clip length is 3–10 seconds and it is decided by the model from the
 * prompt; there is no `duration_seconds` and no `fps` to set, so a caller cannot ask for exactly
 * five seconds and a reel is assembled from however long each shot came out. The same goes for
 * negative prompts, temperature and seeds — all unsupported, so a negative belongs in the prompt
 * as a sentence.
 *
 * ── Why 1080p is not the default ──────────────────────────────────────────────────────────────
 * 360p and 720p are generated; 1080p and 4k are upscales of the same render. Paying for an upscale
 * the model did not natively produce is a choice, not a quality setting, so the caller makes it
 * explicitly.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta"

/** Generous: a single generation legitimately takes minutes, and killing it still costs money. */
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000
const FILE_TIMEOUT_MS = 60 * 1000

export type AspectRatio = "9:16" | "16:9"
export type Resolution = "360p" | "720p" | "1080p" | "4k"

export interface ImagePart {
  /** Raw bytes. Base64 happens here so no caller has to remember to do it. */
  data: Buffer
  mimeType: string
}

export interface GenerateInput {
  apiKey: string
  model: string
  prompt: string
  aspectRatio: AspectRatio
  resolution: Resolution
  /**
   * One image anchors the opening frame; two interpolate from the first to the second. More than
   * two is refused rather than silently truncated — a caller passing three has misunderstood
   * something, and dropping one quietly would produce a video that is subtly not what was asked.
   */
  images?: ImagePart[]
  /** Set on a continuation: the id of the interaction whose video this one carries on from. */
  previousInteractionId?: string
}

export interface GenerateResult {
  ok: boolean
  /** Pass as `previousInteractionId` to continue this clip. Absent means the chain ends here. */
  interactionId?: string
  /** Where the video can be fetched from. One of these two is set when ok. */
  fileUri?: string
  inlineData?: Buffer
  error?: string
  /** Google's own words, for a screen that has to explain a refusal to a person. */
  raw?: string
}

interface OmniContentItem {
  type?: string
  mime_type?: string
  data?: string
  uri?: string
}

interface OmniStep {
  type?: string
  content?: OmniContentItem[]
}

interface OmniInteraction {
  id?: string
  status?: string
  steps?: OmniStep[]
  error?: { message?: string } | string
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.name === "AbortError" ? "timed out" : err.message
  return String(err)
}

/**
 * Starts a generation and waits for it.
 *
 * ── Why this blocks instead of returning a handle ─────────────────────────────────────────────
 * Because the API does. There is no operation to poll: the interaction request stays open and the
 * result — including the uri, which the docs say is only guaranteed in the creation response —
 * comes back on it. The caller's job is therefore to not await this inside an HTTP handler, which
 * is exactly what the reel service does.
 */
export async function generateVideo(input: GenerateInput): Promise<GenerateResult> {
  if (!input.apiKey) return { ok: false, error: "No API key was supplied." }
  if ((input.images?.length ?? 0) > 2) {
    return { ok: false, error: "A shot takes at most two images: an opening frame, or a first and a last." }
  }

  /**
   * A continuation sends the prompt alone.
   *
   * Images and a previous interaction are mutually exclusive — one says "start here" and the other
   * says "carry on from there", and sending both asks the model to do two incompatible things with
   * the first frame. Refused rather than resolved by precedence, because guessing which the caller
   * meant would produce a shot that cost money and continued the wrong thing.
   */
  if (input.previousInteractionId && input.images?.length) {
    return {
      ok: false,
      error: "A continuation cannot also take anchor images — it continues from the previous shot's last frame.",
    }
  }

  const parts: unknown[] = []
  for (const image of input.images ?? []) {
    parts.push({ type: "image", data: image.data.toString("base64"), mime_type: image.mimeType })
  }
  parts.push({ type: "text", text: input.prompt })

  const body: Record<string, unknown> = {
    model: input.model,
    /* A lone string is accepted, but the array form is the shape that also carries images, so it is
       used for both rather than branching on whether this shot happens to have one. */
    input: parts,
    response_format: {
      type: "video",
      aspect_ratio: input.aspectRatio,
      resolution: input.resolution,
      /* Anything over 4MB comes back as a uri regardless; asking for it always means one code path
         rather than two, and a 25-second reel is never under 4MB. */
      delivery: "uri",
    },
  }

  if (input.previousInteractionId) {
    body.previous_interaction_id = input.previousInteractionId
    /* Named explicitly even though the docs say prompting is usually enough. On a chain where every
       call costs ten cents a second, "usually" is not the basis for a request. */
    body.generation_config = { video_config: { task: "extend" } }
  } else if (input.images?.length) {
    body.generation_config = {
      video_config: { task: input.images.length === 2 ? "first_last_frame_to_video" : "image_to_video" },
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS)

  try {
    const res = await fetch(`${API_BASE}/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await res.text()

    if (!res.ok) {
      return { ok: false, error: `Google refused the request (HTTP ${res.status}).`, raw: text.slice(0, 600) }
    }

    let payload: OmniInteraction
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, error: "Google returned something that was not JSON.", raw: text.slice(0, 600) }
    }

    if (payload.error) {
      const message = typeof payload.error === "string" ? payload.error : payload.error.message
      return { ok: false, error: message || "Google reported an error.", raw: text.slice(0, 600) }
    }

    /* The video is wherever in the steps it happens to be. Searching rather than indexing, because
       the step list carries user input and the model's own reasoning alongside the output, and
       their order is not something to depend on. */
    const video = (payload.steps ?? [])
      .flatMap((step) => step.content ?? [])
      .find((item) => item.type === "video" && (item.uri || item.data))

    if (!video) {
      return {
        ok: false,
        /* Distinguished from a refusal: the call succeeded and produced no video, which usually
           means the prompt was blocked rather than that anything is broken. */
        error: `Google returned no video (status: ${payload.status ?? "unknown"}).`,
        raw: text.slice(0, 600),
        interactionId: payload.id,
      }
    }

    return {
      ok: true,
      interactionId: payload.id,
      fileUri: video.uri,
      inlineData: video.data ? Buffer.from(video.data, "base64") : undefined,
    }
  } catch (err) {
    return { ok: false, error: `The request to Google failed — ${describe(err)}.` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Downloads a generated video.
 *
 * A uri points at the Files API, where the file is not immediately readable: it has a state, and
 * downloading before it reaches ACTIVE returns an error rather than bytes. So this waits for the
 * state and then fetches, which is the step the Python guide's `files.download` hides.
 */
export async function downloadVideo(
  fileUri: string,
  apiKey: string,
  { attempts = 30, intervalMs = 5000 }: { attempts?: number; intervalMs?: number } = {}
): Promise<{ ok: boolean; bytes?: Buffer; error?: string }> {
  /* The id is the tail of the uri. Taken that way rather than parsed as a path, because the uri's
     shape is Google's to change and its last segment is the part that is actually documented. */
  const fileId = fileUri.split("/").filter(Boolean).pop()
  if (!fileId) return { ok: false, error: "The video URI Google returned has no file id in it." }

  const headers = { "x-goog-api-key": apiKey }

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS)

    try {
      const res = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}`, {
        headers,
        signal: controller.signal,
      })
      const text = await res.text()

      if (!res.ok) return { ok: false, error: `Could not read the video's state (HTTP ${res.status}).` }

      const state = (JSON.parse(text) as { state?: string }).state

      if (state === "ACTIVE") break
      if (state === "FAILED") return { ok: false, error: "Google reported the video file as failed." }
    } catch (err) {
      return { ok: false, error: `Could not read the video's state — ${describe(err)}.` }
    } finally {
      clearTimeout(timer)
    }

    if (attempt === attempts - 1) {
      return { ok: false, error: "The video was still not ready after waiting. It may appear shortly." }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS)

  try {
    const res = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}:download?alt=media`, {
      headers,
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, error: `Downloading the video failed (HTTP ${res.status}).` }

    return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) }
  } catch (err) {
    return { ok: false, error: `Downloading the video failed — ${describe(err)}.` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What a render cost, in US cents.
 *
 * Google bills video as output tokens at 5,792 tokens per second of 720p and $17.50 per million,
 * which is ten cents a second. Computed from those two published numbers rather than a hard-coded
 * dime, so the arithmetic is visible and a price change is a one-line edit.
 *
 * Only 720p has a published rate. The others are charged as what they are: an upscale is billed on
 * the render underneath it, and 360p is assumed to cost no more than 720p rather than guessed to
 * cost less — an estimate that is too low would understate a spend cap, which is the one direction
 * that matters.
 */
export function estimateCents(seconds: number): number {
  const TOKENS_PER_SECOND = 5792
  const USD_PER_MILLION_TOKENS = 17.5
  return Math.ceil((seconds * TOKENS_PER_SECOND * USD_PER_MILLION_TOKENS) / 1_000_000 * 100)
}
