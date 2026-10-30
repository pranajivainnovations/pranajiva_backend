/**
 * Turning a scene's fields into the one string Google receives.
 *
 * ── Why the fields are separate at all ────────────────────────────────────────────────────────
 * Because an operator writing one freehand paragraph reliably forgets the things that matter most
 * to this model. It responds to concrete cinematography — "eye-level medium shot", "slow push-in
 * dolly" — far better than to adjectives, and it invents an audio track unless told not to. Five
 * small fields get those said every time; one big box gets them said on the days somebody
 * remembers.
 *
 * ── Why everything ends up in the prompt anyway ───────────────────────────────────────────────
 * Because the API has nowhere else to put any of it. There is no duration parameter, no
 * negative_prompt, no camera field, no audio setting — the documentation is explicit that negatives
 * go in the prompt as a sentence and that length is steered by timecodes in the text. So this is
 * not a convenience layer over a structured API; it is the only way to pass these instructions at
 * all, and composing them in a fixed order is what makes two scenes comparable.
 *
 * ── Why the order is this order ───────────────────────────────────────────────────────────────
 * Camera first, because it frames everything after it. Then what happens. Then the timecode, which
 * reads as a direction rather than a constraint when it follows the action. Then audio, then what
 * to avoid — last, because a negative read first colours everything that follows it.
 */

export interface SceneFields {
  prompt: string
  shotType?: string | null
  cameraMove?: string | null
  audioNote?: string | null
  avoid?: string | null
  targetSeconds?: number | null
  /** How many reference images this scene supplies, so they can be named in the text. */
  imageCount?: number
  /** True when this scene extends another, which changes what the text should say. */
  isContinuation?: boolean
}

/** Trims, collapses whitespace, and drops a trailing full stop so sentences can be joined cleanly. */
function clean(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
}

/**
 * The shot types and camera moves offered to an operator.
 *
 * A closed list rather than a free text box, because the value of these fields is that they use the
 * model's own vocabulary. "Zoomed out a bit" and "wide shot" are the same intention and only one of
 * them lands, and a dropdown is how the right one gets picked without anybody having to know that.
 */
export const SHOT_TYPES = [
  "Extreme wide shot",
  "Wide shot",
  "Medium shot",
  "Medium close-up",
  "Close-up",
  "Extreme close-up",
  "Over-the-shoulder shot",
  "Low-angle shot",
  "High-angle shot",
  "Eye-level shot",
  "Front view, eye-level",
  "Top-down overhead shot",
] as const

export const CAMERA_MOVES = [
  "Static camera",
  "Slow push-in dolly",
  "Slow pull-back dolly",
  "Slow pan left",
  "Slow pan right",
  "Slow tilt up",
  "Slow tilt down",
  "Handheld, subtle movement",
  "Orbit around the subject",
  "Crane up",
  "Tracking shot following the subject",
] as const

/**
 * Builds the text sent to Google, and the reference tags that go with it.
 *
 * ── Why the image tags are written into the text ──────────────────────────────────────────────
 * Reference images are addressed from the prompt as IMAGE_REF_0 upward — supplying the bytes is
 * only half of it, and a scene that attaches two likenesses without naming them is a scene that
 * sent two images the model had no instruction about. So the tags are emitted whenever there are
 * images and the operator has not already referred to them, which keeps it automatic without
 * overriding somebody who knows exactly what they want.
 */
export function composeScenePrompt(scene: SceneFields): string {
  const parts: string[] = []

  const camera = [clean(scene.shotType), clean(scene.cameraMove)].filter(Boolean).join(", ")
  if (camera) parts.push(`${camera}.`)

  const body = clean(scene.prompt)
  if (body) parts.push(`${body}.`)

  /**
   * A continuation says so in words as well as through previous_interaction_id.
   *
   * Drift between shots is the known failure of chained extension, and the documented remedy is
   * connective language that pins the camera and the look. Added only when the operator has not
   * already said something of the kind, so it reinforces their wording rather than arguing with it.
   */
  if (scene.isContinuation && !/continu|same|maintain|identical/i.test(body)) {
    parts.push(
      "Continue the same continuous camera motion, with identical character appearance, wardrobe and lighting."
    )
  }

  /* Reference tags, named only when the operator has not named them. */
  const imageCount = scene.imageCount ?? 0
  if (imageCount > 0 && !/IMAGE_REF_/i.test(body)) {
    const tags = Array.from({ length: imageCount }, (_, i) => `<IMAGE_REF_${i}>`)
    parts.push(
      imageCount === 1
        ? `Use ${tags[0]} as the reference for the subject's appearance and wardrobe.`
        : `Use ${tags.join(", ")} as references for the subjects' appearance and wardrobe, keeping them consistent.`
    )
  }

  /**
   * The timecode.
   *
   * This is the only lever on length there is, and it is a hint rather than an instruction — the
   * model picks between 3 and 10 seconds whatever this says. Written as a range from zero because
   * that is the form the documentation gives, and expressed as "about" so the sentence does not
   * promise what the API cannot.
   */
  const seconds = Number(scene.targetSeconds ?? 0)
  if (seconds >= 3 && seconds <= 10) {
    parts.push(`Pace the action to fill about [0-${seconds}s].`)
  }

  const audio = clean(scene.audioNote)
  if (audio) {
    /* "No dialogue" and the like are passed through as written; anything else is framed as audio so
       a description of ambience is not mistaken for something to show on screen. */
    parts.push(/^no\b/i.test(audio) ? `${audio}.` : `Audio: ${audio}.`)
  }

  const avoid = clean(scene.avoid)
  if (avoid) parts.push(`Do not include ${avoid}.`)

  return parts.join(" ")
}

/**
 * A preview of what will be sent, for a screen that wants to show it before anything is charged.
 *
 * The same function, deliberately — a preview assembled by different code is a preview that is
 * eventually wrong, and at fifty cents a take the operator is entitled to read the actual text.
 */
export const previewScenePrompt = composeScenePrompt
