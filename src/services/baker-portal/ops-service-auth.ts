import crypto from "crypto"

/**
 * Service-to-service authentication for the OPS tool.
 *
 * OPS reads Postgres directly for everything it does, so it has never needed to talk to this
 * backend — but issuing a baker activation is different. That logic (token generation, hashing,
 * revoking the previous invite, refusing an already-claimed bakery) lives here, and a second
 * implementation in OPS would be two copies of a security-sensitive flow drifting apart.
 *
 * So OPS calls us, and needs a way to prove it is OPS. This is deliberately NOT a new user-facing
 * identity: it does not create sessions, does not represent a person, and grants exactly one
 * capability. The human authorization already happened — the OPS user signed in against
 * ops_session before their server action ran. This only establishes that the *caller* is the OPS
 * application and not the open internet.
 *
 * The key is used only server-side (an OPS server action), so it never reaches a browser.
 */

/**
 * Compared in constant time. A plain `===` on a secret leaks its prefix through timing: an attacker
 * who can measure the difference learns one character at a time. The length check happens first
 * because timingSafeEqual throws on mismatched buffers, and length alone is not worth protecting.
 */
export function isValidOpsServiceKey(provided: string | undefined): boolean {
  const expected = process.env.OPS_SERVICE_KEY

  if (!expected || expected.length < 32) {
    // Fail closed. An unset or trivially short key must never mean "let everyone in" — the most
    // likely cause is a misconfigured deploy, and silently accepting every caller would be the
    // worst possible response to that.
    console.error("[ops-service-auth] OPS_SERVICE_KEY is unset or too short — refusing all calls")
    return false
  }

  if (!provided || provided.length !== expected.length) {
    return false
  }

  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

export const OPS_SERVICE_KEY_HEADER = "x-ops-service-key"
