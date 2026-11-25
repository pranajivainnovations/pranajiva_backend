import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto"

/**
 * Sealing Meta credentials (meta.credentials.sealed) at rest.
 *
 * The scheme of ai-video/secret-box.ts — AES-256-GCM, key derived by HKDF from a secret the server
 * already has — under its own label, so a key derived for Meta tokens cannot open anything another
 * subsystem sealed from the same root, nor the reverse.
 *
 * META_TOKEN_SECRET overrides the root for anyone who wants to rotate these independently. Setting
 * it later makes every stored token unreadable, and OPS then asks for the token again.
 */

const LABEL = "meta.credentials.v1"
const PREFIX = "v1"

function key(): Buffer {
  const root = process.env.META_TOKEN_SECRET || process.env.COOKIE_SECRET || process.env.JWT_SECRET
  if (!root || root.length < 16) {
    throw new Error("[meta] No secret to derive the credential key from (COOKIE_SECRET or JWT_SECRET).")
  }
  return Buffer.from(hkdfSync("sha256", root, LABEL, LABEL, 32))
}

export function sealToken(plaintext: string): string {
  if (!plaintext) throw new Error("[meta] Refusing to seal an empty token.")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(":")
}

export function openToken(sealed: string): string {
  const parts = String(sealed ?? "").split(":")
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("A stored Meta token is unreadable. Connect the account again.")
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(parts[1], "base64url"))
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"))
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8")
  } catch {
    throw new Error("A stored Meta token is unreadable. Connect the account again.")
  }
}

export function tokenLast4(plaintext: string): string {
  return plaintext.length >= 20 ? plaintext.slice(-4) : ""
}
