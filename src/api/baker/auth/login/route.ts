import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"
import {
  burnPasswordComparison,
  createBakerSessionToken,
  normalizeBakerPublicId,
  verifyPassword,
  BAKER_SESSION_DURATION_SECONDS,
} from "../../../../services/baker-portal/auth"

/**
 * POST /baker/auth/login
 *
 * Body: { bakerId: "CFB-00042", password: "…" }
 * 200:  { token, expiresIn, baker: { publicId, name, role } }
 * 401:  { error }
 *
 * Baker ID rather than email, because bakers are onboarded from Google Places data where the email
 * is routinely missing, shared between outlets, or wrong. The ID is minted by us, always present,
 * and can be read down a phone line during onboarding.
 *
 * The token is returned in the body rather than set as a cookie here: the Baker Portal is a
 * separate application on its own domain (baker.crossfriend.in), so it owns its own cookie and
 * forwards the token as a bearer. A Set-Cookie from this origin would not reach it anyway.
 *
 * Every failure returns the same message and takes roughly the same time — see the dummy hash
 * below. Baker IDs are sequential, so "does CFB-00007 exist" must not be answerable by either the
 * response text or a stopwatch.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const GENERIC_FAILURE = "Baker ID or password is incorrect."

  try {
    const body = (req.body ?? {}) as { bakerId?: string; password?: string }
    const publicId = normalizeBakerPublicId(String(body.bakerId ?? ""))
    const password = String(body.password ?? "")

    if (!publicId || !password) {
      return res.status(401).json({ error: GENERIC_FAILURE })
    }

    const db = getBakerNetworkDbPool()
    const result = await db.query(
      `SELECT bu.id AS baker_user_id, bu.password_hash, bu.role, bu.is_active AS user_active,
              b.id  AS baker_id, b.public_id, b.name, b.is_active AS baker_active
         FROM baker_network.bakers b
         JOIN baker_network.baker_users bu ON bu.baker_id = b.id AND bu.role = 'owner' AND bu.is_active
        WHERE UPPER(b.public_id) = $1
        LIMIT 1`,
      [publicId]
    )

    const row = result.rows[0]
    if (!row) {
      // Spend the same time we would have spent hashing, so an unknown Baker ID is not
      // distinguishable from a wrong password by response latency.
      await burnPasswordComparison(password)
      return res.status(401).json({ error: GENERIC_FAILURE })
    }

    const passwordOk = await verifyPassword(password, row.password_hash)
    if (!passwordOk || !row.user_active) {
      return res.status(401).json({ error: GENERIC_FAILURE })
    }
    if (!row.baker_active) {
      // Worth distinguishing: the credentials were right, so telling them to contact us is
      // actionable, and it leaks nothing they did not already prove they know.
      return res.status(403).json({ error: "This bakery account is currently inactive." })
    }

    const token = await createBakerSessionToken({
      bakerUserId: row.baker_user_id,
      bakerId: row.baker_id,
      bakerPublicId: row.public_id,
      role: row.role,
    })

    await db.query(
      `UPDATE baker_network.baker_users SET last_login_at = NOW() WHERE id = $1`,
      [row.baker_user_id]
    )

    return res.status(200).json({
      token,
      expiresIn: BAKER_SESSION_DURATION_SECONDS,
      baker: { publicId: row.public_id, name: row.name, role: row.role },
    })
  } catch (error) {
    console.error("[API /baker/auth/login] Error:", error)
    return res.status(500).json({ error: "Something went wrong signing in. Please try again." })
  }
}
