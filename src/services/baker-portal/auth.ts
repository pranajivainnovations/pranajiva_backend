/**
 * Baker identity — the third and last of CrossFriend's three separate identities.
 *
 *   Customer  ->  _medusa_jwt    signed with JWT_SECRET            (Medusa's own auth)
 *   OPS       ->  ops_session    signed with SESSION_SECRET        (crossfriend-ops)
 *   Baker     ->  baker_session  signed with BAKER_SESSION_SECRET  (this module)
 *
 * The separation is enforced by the signing keys being different values, not by route naming or by
 * cookie names. A token minted for OPS cannot verify here even if an attacker puts it in the right
 * cookie on the right domain, because the key it was signed with is not the key this verifies with.
 * That is why BAKER_SESSION_SECRET must never be set to the same string as the other two.
 *
 * Authorization lives here, in the backend, rather than in the Baker Portal. The portal holds the
 * token in an httpOnly cookie and forwards it; it never decides who a baker is or what they own.
 * A frontend that could answer "which baker am I" could also be persuaded to answer it wrongly.
 *
 * Mirrors crossfriend-ops/src/lib/auth.ts deliberately — same library (jose HS256), same hashing
 * (bcrypt cost 12), same 7-day window. Two auth implementations that behave differently is how
 * subtle security bugs get introduced in the one nobody looks at.
 */

import { SignJWT, jwtVerify } from "jose"
import bcrypt from "bcryptjs"

export const BAKER_SESSION_COOKIE = "baker_session"
export const BAKER_SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7 // 7 days

const BCRYPT_COST = 12

function getSecretKey(): Uint8Array {
  const secret = process.env.BAKER_SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      "BAKER_SESSION_SECRET must be set and at least 32 characters long"
    )
  }
  return new TextEncoder().encode(secret)
}

export interface BakerSessionPayload {
  /** baker_users.id — the person. */
  bakerUserId: string
  /** bakers.id — the organisation they act for. */
  bakerId: string
  /** bakers.public_id, e.g. CFB-00042. Carried for display and logging only. */
  bakerPublicId: string
  role: "owner" | "staff"
}

export async function createBakerSessionToken(
  payload: BakerSessionPayload
): Promise<string> {
  return new SignJWT({
    bakerId: payload.bakerId,
    bakerPublicId: payload.bakerPublicId,
    role: payload.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.bakerUserId)
    .setIssuedAt()
    .setExpirationTime(`${BAKER_SESSION_DURATION_SECONDS}s`)
    .sign(getSecretKey())
}

export async function verifyBakerSessionToken(
  token: string
): Promise<BakerSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey())
    if (
      typeof payload.sub !== "string" ||
      typeof payload.bakerId !== "string" ||
      typeof payload.bakerPublicId !== "string" ||
      (payload.role !== "owner" && payload.role !== "staff")
    ) {
      return null
    }
    return {
      bakerUserId: payload.sub,
      bakerId: payload.bakerId,
      bakerPublicId: payload.bakerPublicId,
      role: payload.role,
    }
  } catch {
    // Expired, tampered, or signed with a different key — all equally "not a session".
    return null
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST)
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

/**
 * A dummy bcrypt comparison, used when no user matched.
 *
 * Without it, a login for an unknown Baker ID returns immediately while a login for a known one
 * spends ~100ms hashing — a difference an attacker can measure to enumerate which Baker IDs exist.
 * Since IDs are sequential (CFB-00001, CFB-00002 …), that enumeration is otherwise trivial.
 */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.4gDbLvXOTvAeXjrfhkjLPMMOMWiVaEy"

export async function burnPasswordComparison(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH)
}

/** Normalises a hand-typed Baker ID: "  cfb-42 " -> "CFB-42". Matching is case-insensitive. */
export function normalizeBakerPublicId(raw: string): string {
  return raw.trim().toUpperCase()
}

/**
 * Minimum password policy for a baker account.
 *
 * Deliberately length-only. Composition rules ("one uppercase, one symbol") measurably push people
 * toward predictable substitutions and writing passwords down, without improving real strength;
 * length is the property that actually matters. 10 is a floor, not a target.
 */
export function validatePassword(password: string): string | null {
  if (password.length < 10) {
    return "Password must be at least 10 characters."
  }
  if (password.length > 200) {
    return "Password must be 200 characters or fewer."
  }
  return null
}

/** Extracts a bearer token from an Authorization header, if present and well-formed. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}
