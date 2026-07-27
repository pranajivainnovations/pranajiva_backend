/**
 * Runs multer as a plain function inside a Medusa v1 route handler.
 *
 * Medusa v1's file-based routes call the exported handler directly with
 * (req, res) — there's no per-route middleware chain to hook into the way a
 * plain Express app would have, so multer is invoked manually here instead
 * of relying on Medusa's (undocumented, version-fragile) middleware
 * registration. req/res are real Express objects underneath, so this works
 * the same way multer always does.
 */

import multer from "multer"
import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // keep in sync with upload-validation.ts's MAX_UPLOAD_BYTES
})

/** Parses a single-file multipart/form-data request. Populates req.file and req.body. */
export function runSingleFileUpload(req: MedusaRequest, res: MedusaResponse, fieldName = "file"): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single(fieldName)(req as any, res as any, (err: unknown) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
