import crypto from "crypto"
import jwt from "jsonwebtoken"
import type { MedusaRequest } from "@medusajs/medusa"

/**
 * Turning a verified mobile number into a Medusa customer session.
 *
 * ── The problem this replaces ──────────────────────────────────────────────────────────────────
 * The storefront used to derive a customer's password from their mobile number and a shared salt,
 * then log in with it. That made the salt a master key: anyone holding it could compute any
 * customer's password and authenticate as them directly against `POST /store/auth`, never touching
 * the OTP flow, never sending an SMS, never hitting a rate limit. Every control built around
 * one-time codes guarded one door while a second, unguarded one stood beside it.
 *
 * The fix is not a better derivation. It is having no derivation at all: the server that verified
 * the code issues the session itself.
 *
 * ── Why the password is randomised on every sign-in, not just at creation ──────────────────────
 * Existing customers already have a derived password stored. Login no longer uses it, but
 * `POST /store/auth` still accepts it — so until it is overwritten, the old attack still works on
 * every account created before this shipped. Rotating on each verify makes the migration
 * self-healing: an account is repaired the first time its owner signs in, with no list to work
 * through and nothing to remember. The value is thrown away immediately and never recomputed.
 */

/**
 * New accounts get the right domain; existing ones are still found under the old one.
 *
 * The synthetic address is an internal identifier — Medusa requires a unique email and a mobile
 * number is what we actually have. It was `@pranajiva.in`, which is the wrong brand for this
 * storefront and would surface on receipts. Changing it for new customers is free; rewriting it for
 * existing ones would break the only key we have to find them by, for cosmetic gain.
 */
const EMAIL_DOMAIN = "crossfriend.in"
const LEGACY_EMAIL_DOMAINS = ["pranajiva.in"]

export function syntheticEmail(mobile: string): string {
  return `${mobile}@${EMAIL_DOMAIN}`
}

/**
 * A password nobody knows, including us.
 *
 * Never returned, never logged, never derivable. Its only job is to satisfy Medusa's requirement
 * that a customer have one — and to be useless to anyone who obtains the database.
 *
 * Worth knowing: Medusa hashes customer passwords with scrypt at `logN: 1`, a work factor of two,
 * which is effectively no key stretching. That is survivable for a random 48-byte secret and would
 * be dangerous for anything guessable — another reason the derived scheme had to go rather than be
 * improved.
 */
function randomPassword(): string {
  return crypto.randomBytes(48).toString("base64url")
}

export interface CustomerSession {
  token: string
  customerId: string
  isNewUser: boolean
}

/**
 * Find or create the customer for a verified mobile number, and return a session token.
 *
 * Must only be called after the one-time code has actually been verified. There is no check here —
 * this function trusts its caller completely, because it is the thing that hands out sessions.
 */
export async function issueCustomerSession(
  req: MedusaRequest,
  mobile: string
): Promise<CustomerSession> {
  const customerService = req.scope.resolve("customerService") as any
  const jwtSecret = req.scope.resolve("configModule").projectConfig.jwt_secret

  if (!jwtSecret) {
    // Refused rather than defaulted. A predictable signing key means anyone can mint a session for
    // any customer, which is a worse failure than sign-in being unavailable.
    throw new Error("jwt_secret is not configured")
  }

  const candidates = [
    syntheticEmail(mobile),
    ...LEGACY_EMAIL_DOMAINS.map((domain) => `${mobile}@${domain}`),
  ]

  let customer: { id: string } | null = null
  for (const email of candidates) {
    customer = await customerService.retrieveRegisteredByEmail(email).catch(() => null)
    if (customer) break
  }

  const isNewUser = !customer

  if (!customer) {
    customer = await customerService.create({
      email: syntheticEmail(mobile),
      password: randomPassword(),
      /* Left blank rather than filled with the phone number, which is what the old flow did — it
         made every customer appear in admin as their own mobile. The profile is where a real name
         gets added, by the person it belongs to. */
      first_name: "",
      last_name: "",
      phone: `+91${mobile}`,
    })
  } else {
    /* The self-healing migration described above. Failure is logged and swallowed: the customer has
       proved possession of their number and is entitled to sign in, and the next verify tries
       again. */
    try {
      await customerService.update(customer.id, { password: randomPassword() })
    } catch (error) {
      console.error("[session] could not rotate stored password", error)
    }
  }

  /* The exact payload and lifetime Medusa's own /store/auth issues, so every existing authenticated
     route accepts this token with no special handling. */
  const token = jwt.sign({ customer_id: customer!.id, domain: "store" }, jwtSecret, {
    expiresIn: "30d",
  })

  return { token, customerId: customer!.id, isNewUser }
}
