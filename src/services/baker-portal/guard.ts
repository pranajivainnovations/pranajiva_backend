import type { MedusaRequest } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../baker-network/db"
import { bearerFromHeader, verifyBakerSessionToken } from "./auth"

/**
 * The single gate every /baker/* route passes through.
 *
 * Two checks, not one. Verifying the JWT proves the token was minted by us and has not expired —
 * but a token stays valid for seven days, and a baker suspended on Monday must not still be
 * trading on Tuesday. So the database is re-read on every request to confirm the user and the
 * organisation are both still active. That costs one indexed lookup, which is the right price for
 * revocation that takes effect immediately rather than whenever the token happens to expire.
 *
 * Returns the baker_id from the SESSION. No route may take a baker id from a request body, query
 * string, or product metadata — that is the whole point of the ownership model, and this is the
 * only place a baker id is allowed to enter the system.
 */

export interface BakerContext {
  bakerUserId: string
  bakerId: string
  bakerPublicId: string
  role: "owner" | "staff"
  bakerName: string
}

/**
 * A single shape rather than a discriminated union on `ok`. This project's tsconfig does not enable
 * `strict`/`strictNullChecks`, so `true` and `false` widen to `boolean` and TypeScript cannot narrow
 * a union by that field — callers would get "Property 'status' does not exist" on the very branch
 * where it does. Checking `ctx` for null works identically under either setting.
 */
export interface GuardResult {
  /** Non-null exactly when the caller is an authenticated, active baker user. */
  ctx: BakerContext | null
  status: number
  error: string | null
}

function deny(status: number, error: string): GuardResult {
  return { ctx: null, status, error }
}

function allow(ctx: BakerContext): GuardResult {
  return { ctx, status: 200, error: null }
}

export async function requireBakerUser(req: MedusaRequest): Promise<GuardResult> {
  const token = bearerFromHeader(req.headers.authorization as string | undefined)
  if (!token) {
    return deny(401, "Not signed in.")
  }

  const session = await verifyBakerSessionToken(token)
  if (!session) {
    return deny(401, "Your session has expired. Please sign in again.")
  }

  const db = getBakerNetworkDbPool()
  const result = await db.query(
    `SELECT bu.id           AS baker_user_id,
            bu.role         AS role,
            bu.is_active    AS user_active,
            b.id            AS baker_id,
            b.public_id     AS baker_public_id,
            b.name          AS baker_name,
            b.is_active     AS baker_active
       FROM baker_network.baker_users bu
       JOIN baker_network.bakers b ON b.id = bu.baker_id
      WHERE bu.id = $1`,
    [session.bakerUserId]
  )

  const row = result.rows[0]
  if (!row || !row.user_active) {
    return deny(401, "Your session has expired. Please sign in again.")
  }
  if (!row.baker_active) {
    return deny(403, "This bakery account is currently inactive.")
  }

  // Trust the database over the token for everything except identity. A baker moved between
  // organisations, or promoted from staff to owner, should not have to wait out a stale token.
  return allow({
    bakerUserId: row.baker_user_id,
    bakerId: row.baker_id,
    bakerPublicId: row.baker_public_id,
    role: row.role,
    bakerName: row.baker_name,
  })
}
