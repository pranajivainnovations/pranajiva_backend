import crypto from "crypto"
import { getBakerNetworkDbPool } from "../baker-network/db"
import { hashPassword, validatePassword } from "./auth"

/**
 * Account claiming — how an ops-onboarded baker turns into a baker who can log in.
 *
 *   ops issues an activation  ->  single-use token, handed to the baker out of band
 *   baker opens the link      ->  token validated, bakery name shown so they know it's theirs
 *   baker sets a password     ->  token burned, owner account created, claimed
 *
 * There is no public registration and no self-service password reset in V1 — ops reissues, which
 * revokes the previous token. That is a deliberate consequence of an invite-only network: the
 * people who can create baker accounts are the same people who verified the bakery exists.
 *
 * Claiming is entirely separate from the blue tick. Nothing here reads or writes bakers.blue_tick.
 * Claiming proves control of the account; the blue tick attests to quality, and is granted later
 * against criteria that have nothing to do with whether someone knows a token.
 *
 * ── Why only a hash of the token is stored ──────────────────────────────────────────────────────
 * The raw token is returned to ops exactly once, at creation, and never persisted. Only its
 * SHA-256 hash goes in the database. So a database leak — or an OPS user browsing
 * baker_activations in the Database Explorer — cannot be turned into an account takeover.
 * SHA-256 rather than bcrypt here on purpose: these are 256 bits of CSPRNG output, not a
 * human-chosen secret, so there is nothing to brute-force and no reason to pay bcrypt's cost on a
 * lookup that must be indexed.
 */

/** Activation links are short-lived; an invite left unclaimed for a fortnight should be reissued. */
export const ACTIVATION_TTL_DAYS = 14

export function hashActivationToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex")
}

/** URL-safe, 256 bits of entropy. Long enough that guessing is not a threat model. */
function generateRawToken(): string {
  return crypto.randomBytes(32).toString("base64url")
}

export interface IssuedActivation {
  /** Shown to ops ONCE. Never retrievable again — reissue if it is lost. */
  rawToken: string
  expiresAt: Date
  bakerPublicId: string
  bakerName: string
}

/**
 * Issues (or reissues) an activation for a baker.
 *
 * Revoking any existing live token first is what keeps `idx_baker_activations_one_live` satisfied,
 * and it is also the correct behaviour: reissuing must invalidate whatever is sitting in the
 * baker's inbox, or two valid invitations exist at once.
 */
export async function issueActivation(
  bakerId: string,
  opsUserId: string | null
): Promise<IssuedActivation> {
  const db = getBakerNetworkDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    const bakerResult = await client.query(
      `SELECT id, public_id, name, is_active FROM baker_network.bakers WHERE id = $1 FOR UPDATE`,
      [bakerId]
    )
    const baker = bakerResult.rows[0]
    if (!baker) throw new Error("Baker not found")
    if (!baker.is_active) throw new Error("Baker is inactive")

    const claimed = await client.query(
      `SELECT 1 FROM baker_network.baker_users WHERE baker_id = $1 AND is_active LIMIT 1`,
      [bakerId]
    )
    if (claimed.rowCount) {
      throw new Error("This bakery has already claimed its account")
    }

    await client.query(
      `UPDATE baker_network.baker_activations
          SET revoked_at = NOW()
        WHERE baker_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [bakerId]
    )

    const rawToken = generateRawToken()
    const expiresAt = new Date(Date.now() + ACTIVATION_TTL_DAYS * 24 * 60 * 60 * 1000)

    await client.query(
      `INSERT INTO baker_network.baker_activations (baker_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4)`,
      [bakerId, hashActivationToken(rawToken), expiresAt, opsUserId]
    )

    await client.query("COMMIT")

    return {
      rawToken,
      expiresAt,
      bakerPublicId: baker.public_id,
      bakerName: baker.name,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export interface ActivationPreview {
  bakerPublicId: string
  bakerName: string
  city: string | null
}

/**
 * Validates a token without consuming it, so the activation page can greet the baker by name.
 *
 * Showing the bakery name matters: it is how the person on the other end knows the link is
 * genuinely theirs before they type a password into it.
 */
export async function inspectActivation(rawToken: string): Promise<ActivationPreview | null> {
  const db = getBakerNetworkDbPool()
  const result = await db.query(
    `SELECT b.public_id, b.name, b.city
       FROM baker_network.baker_activations a
       JOIN baker_network.bakers b ON b.id = a.baker_id
      WHERE a.token_hash = $1
        AND a.used_at IS NULL
        AND a.revoked_at IS NULL
        AND a.expires_at > NOW()
        AND b.is_active
      LIMIT 1`,
    [hashActivationToken(rawToken)]
  )

  const row = result.rows[0]
  return row ? { bakerPublicId: row.public_id, bakerName: row.name, city: row.city } : null
}

export interface RedeemedActivation {
  bakerUserId: string
  bakerId: string
  bakerPublicId: string
  bakerName: string
}

/**
 * Burns the token and creates the owner account, atomically.
 *
 * The row is locked FOR UPDATE and re-checked inside the transaction rather than trusting the
 * earlier inspect() — two people opening the same link at the same moment must not both get an
 * account. The partial unique index on (baker_id) WHERE role='owner' AND is_active is the backstop
 * if the lock is ever bypassed.
 */
export async function redeemActivation(
  rawToken: string,
  password: string,
  name?: string,
  email?: string
): Promise<RedeemedActivation> {
  const passwordError = validatePassword(password)
  if (passwordError) throw new Error(passwordError)

  const db = getBakerNetworkDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    const result = await client.query(
      `SELECT a.id AS activation_id, b.id AS baker_id, b.public_id, b.name AS baker_name
         FROM baker_network.baker_activations a
         JOIN baker_network.bakers b ON b.id = a.baker_id
        WHERE a.token_hash = $1
          AND a.used_at IS NULL
          AND a.revoked_at IS NULL
          AND a.expires_at > NOW()
          AND b.is_active
        FOR UPDATE OF a`,
      [hashActivationToken(rawToken)]
    )

    const row = result.rows[0]
    if (!row) {
      throw new Error("This activation link is invalid, expired, or has already been used.")
    }

    const passwordHash = await hashPassword(password)
    const userResult = await client.query(
      `INSERT INTO baker_network.baker_users (baker_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, 'owner')
       RETURNING id`,
      [row.baker_id, email?.trim() || null, passwordHash, name?.trim() || null]
    )
    const bakerUserId = userResult.rows[0].id

    await client.query(
      `UPDATE baker_network.baker_activations
          SET used_at = NOW(), used_by = $1
        WHERE id = $2`,
      [bakerUserId, row.activation_id]
    )

    await client.query("COMMIT")

    return {
      bakerUserId,
      bakerId: row.baker_id,
      bakerPublicId: row.public_id,
      bakerName: row.baker_name,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
