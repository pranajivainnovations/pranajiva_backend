/**
 * Vision Analyzer — understands an uploaded reference image
 *
 * Deliberately separate from the image-generation ImageProvider abstraction:
 * this never generates pixels, it only looks at an uploaded photo and
 * produces a text description, which then feeds into the existing
 * cake-design-elaborator.ts pipeline as extra context. Configured via env
 * vars (VISION_PROVIDER / VISION_MODEL) — not customer-facing, so unlike the
 * image-generation picker there's no per-request override or allowlist.
 */

export interface VisionAnalysisInput {
  imageBuffer: Buffer
  mimeType: string
  /** What to look for / how to describe it — differs by purpose (theme inspiration vs. recreate this cake). */
  instructions: string
}

export interface VisionAnalyzer {
  readonly name: string
  readonly model: string
  analyzeImage(input: VisionAnalysisInput): Promise<string>
}
