/**
 * AI Image Service — Public API
 *
 * This barrel file exports everything that other parts of the backend
 * might need from the AI image service.
 */

// Main generation function
export { generateCakeDesigns } from "./ai-generation-service"

// Types
export type {
  GenerationRequest,
  GenerationResult,
  DesignOutput,
  GenerateOptions,
  GeneratedImage,
  ImageProvider,
  ProviderConfig,
  CakeDesignSpecification,
} from "./types"

// Provider factory (for testing/admin)
export { getImageProvider, getProviderConfig, resetProvider } from "./provider-factory"

// Design elaborator (understanding stage — for testing/preview)
export { elaborateCakeDesign } from "./cake-design-elaborator"

// Prompt builder (for testing/preview)
export { buildCakePrompt, generateDesignTitle, generateDesignDescription } from "./prompt-builder"

// Tag extractor (for re-tagging existing designs)
export { extractTags } from "./tag-extractor"

// S3 uploader (for manual uploads/admin)
export { uploadGeneratedImages } from "./s3-uploader"
export type { UploadedImage } from "./s3-uploader"
