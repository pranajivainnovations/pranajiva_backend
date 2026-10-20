import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "crypto"

/**
 * Encrypting an operator's API key at rest.
 *
 * ── Why this is encryption and not hashing ────────────────────────────────────────────────────
 * Everywhere else a secret is stored in this system it is hashed, because the only question ever
 * asked of it is "does this match". A password, an OTP, a service key: all one-way. This one is
 * different — the key has to be handed to Google on every call, so it has to come back out, which
 * makes it the one stored secret here that is genuinely reversible and therefore worth being
 * careful about.
 *
 * AES-256-GCM rather than CBC: GCM authenticates as well as encrypts, so a ciphertext that has
 * been altered in the database fails to decrypt instead of decrypting into rubbish that then gets
 * sent to Google as somebody's API key.
 *
 * ── Why the key is derived rather than configured ─────────────────────────────────────────────
 * A new secret in the server's .env would have to be put there by hand before this feature worked
 * at all, and a deploy that ships a screen which cannot save anything is worse than no screen. So
 * the encryption key is derived from a secret the server already has, through HKDF with a label
 * that belongs to this file alone.
 *
 * The label matters. It means this key is not the cookie secret, cannot be swapped for it, and
 * cannot decrypt anything else derived from the same root with a different label — so reusing the
 * root does not let one subsystem read another's secrets.
 *
 * SOCIAL_CRED_SECRET overrides it, for the day somebody wants these rotated independently of
 * sessions. Setting it later invalidates every stored key, which is the correct and obvious
 * consequence: the keys have to be re-entered, and nothing silently half-works.
 */

const LABEL = "social.video_credentials.v1"

/** Versioned so a future scheme can be told apart from this one rather than guessed at. */
const PREFIX = "v1"

function rootSecret(): string {
  const root = process.env.SOCIAL_CRED_SECRET || process.env.COOKIE_SECRET || process.env.JWT_SECRET

  if (!root || root.length < 16) {
    /**
     * Thrown rather than defaulted. A fallback here would mean every instance that forgot to set a
     * secret shared one hard-coded encryption key, which is indistinguishable from storing the
     * keys in plaintext while looking like it isn't.
     */
    throw new Error(
      "[ai-video] No secret available to derive the credential key from. " +
        "COOKIE_SECRET, JWT_SECRET or SOCIAL_CRED_SECRET must be set on the backend."
    )
  }

  return root
}

function derivedKey(): Buffer {
  /* The salt is the label, deliberately: a fixed salt is fine for HKDF when the purpose of the
     derivation is domain separation rather than password stretching. */
  return Buffer.from(hkdfSync("sha256", rootSecret(), LABEL, LABEL, 32))
}

/**
 * Returns `v1:<iv>:<tag>:<ciphertext>`, all base64url.
 *
 * One string rather than three columns, so a half-written row is impossible: either the whole
 * credential is there or none of it is.
 */
export function sealSecret(plaintext: string): string {
  if (!plaintext) throw new Error("[ai-video] Refusing to seal an empty secret.")

  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv)
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])

  return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(
    ":"
  )
}

/**
 * Reverses sealSecret, or throws.
 *
 * Every failure is the same error on purpose. A caller that could tell "the root secret changed"
 * from "this row was tampered with" would be a caller that reports the difference to somebody, and
 * the operator can do nothing about either except enter their key again.
 */
export function openSecret(sealed: string): string {
  const parts = String(sealed ?? "").split(":")

  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("[ai-video] Stored credential is unreadable. Re-enter the API key.")
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", derivedKey(), Buffer.from(parts[1], "base64url"))
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"))
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8")
  } catch {
    throw new Error("[ai-video] Stored credential is unreadable. Re-enter the API key.")
  }
}

/**
 * The last four characters, for a screen that needs to prove which key is saved.
 *
 * Four, not eight: enough for the operator to recognise their own key against Google's console,
 * not enough to narrow a brute force. Short keys return nothing rather than most of themselves.
 */
export function keyFingerprint(plaintext: string): string {
  return plaintext.length >= 12 ? plaintext.slice(-4) : ""
}

/**
 * Whether two keys are the same, without leaking which character differed.
 *
 * Used only to decide whether a save is a no-op. Constant-time because comparing secrets with ===
 * is a habit worth not having, even where the timing tells an attacker nothing they could use.
 */
export function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}
