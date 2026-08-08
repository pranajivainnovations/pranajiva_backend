import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"
import {
  inspectActivation,
  redeemActivation,
} from "../../../../services/baker-portal/activation"
import {
  createBakerSessionToken,
  BAKER_SESSION_DURATION_SECONDS,
} from "../../../../services/baker-portal/auth"

/**
 * GET  /baker/auth/activate?token=…   — validate without consuming
 * POST /baker/auth/activate           — consume, set password, create the owner account
 *
 * Both are unauthenticated by necessity: the token IS the credential, held by someone who does not
 * yet have an account. That is why it is 256 bits of CSPRNG output, single-use, expiring, and
 * stored only as a hash.
 *
 * GET exists so the activation page can show the bakery's name and Baker ID before asking for a
 * password. Without it the baker is typing a secret into a page that has told them nothing —
 * exactly the shape of a phishing flow, and we should not train people to accept that.
 */

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const token = String(req.query.token ?? "").trim()
    if (!token) {
      return res.status(400).json({ error: "Missing activation token." })
    }

    const preview = await inspectActivation(token)
    if (!preview) {
      return res.status(404).json({
        error: "This activation link is invalid, expired, or has already been used.",
      })
    }

    return res.status(200).json({ baker: preview })
  } catch (error) {
    console.error("[API /baker/auth/activate GET] Error:", error)
    return res.status(500).json({ error: "Something went wrong. Please try again." })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const body = (req.body ?? {}) as {
      token?: string
      password?: string
      name?: string
      email?: string
    }

    const token = String(body.token ?? "").trim()
    const password = String(body.password ?? "")

    if (!token) {
      return res.status(400).json({ error: "Missing activation token." })
    }

    const redeemed = await redeemActivation(token, password, body.name, body.email)

    // Sign them straight in. Making someone who just proved control of the account then re-enter
    // the password they set two seconds ago is friction with no security value.
    const sessionToken = await createBakerSessionToken({
      bakerUserId: redeemed.bakerUserId,
      bakerId: redeemed.bakerId,
      bakerPublicId: redeemed.bakerPublicId,
      role: "owner",
    })

    return res.status(200).json({
      token: sessionToken,
      expiresIn: BAKER_SESSION_DURATION_SECONDS,
      baker: {
        publicId: redeemed.bakerPublicId,
        name: redeemed.bakerName,
        role: "owner",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong."
    // redeemActivation throws messages written for the baker to read (bad token, weak password),
    // so they are surfaced as-is. Anything unexpected is logged and generalised.
    const isExpected =
      message.includes("activation link") || message.includes("Password must")
    if (!isExpected) {
      console.error("[API /baker/auth/activate POST] Error:", error)
    }
    return res
      .status(isExpected ? 400 : 500)
      .json({ error: isExpected ? message : "Something went wrong. Please try again." })
  }
}
