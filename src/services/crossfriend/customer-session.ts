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
 * New accounts get a brand-neutral, undeliverable domain; existing ones are still found under the
 * two real ones they were minted with.
 *
 * ── Why this address exists at all ─────────────────────────────────────────────────────────────
 * It is an internal identifier, not a way to reach anyone. Medusa requires every customer to have a
 * unique email; a verified mobile number is the only unique thing we actually hold.
 *
 * ── Why it is no longer either brand's domain ──────────────────────────────────────────────────
 * It was `@pranajiva.in`, then `@crossfriend.in` — each time, the brand of whichever storefront
 * happened to mint the row. That reasoning stops working the moment one customer row serves both
 * brands, which is precisely what the shared wallet requires: a PranaJiva customer who signs in and
 * is shown `9891612826@crossfriend.in` has just been told about a cake business they never asked
 * about. PranaJiva's account page renders `customer.email` verbatim today, so this is not
 * hypothetical, and the same leak runs in both directions as soon as either brand mints for the
 * other.
 *
 * `.invalid` is reserved by RFC 6761 and is guaranteed never to resolve, which buys a second thing:
 * these addresses can never be delivered to. The real domains are domains we own — if a notification
 * provider is ever configured (none is today), every synthetic address silently becomes mail aimed
 * at our own server for a mailbox that does not exist. This one cannot be sent to by construction.
 *
 * ── Why changing it is safe right now, and would not have been later ───────────────────────────
 * There are zero rows under `@crossfriend.in` — every registered customer today predates that
 * change and sits under `@pranajiva.in`. So this costs one entry in the list below rather than a
 * migration. After the first sign-in on the current code it would have cost a data change.
 *
 * Existing rows are never rewritten. Their address is the only key we have to find them by, and
 * rewriting it to look tidier would risk the one thing that must not break.
 */
const EMAIL_DOMAIN = "mobile.invalid"
const LEGACY_EMAIL_DOMAINS = ["crossfriend.in", "pranajiva.in"]

export function syntheticEmail(mobile: string): string {
  return `${mobile}@${EMAIL_DOMAIN}`
}

/** Every address one mobile could be filed under, canonical first. */
function candidateEmails(mobile: string): string[] {
  return [syntheticEmail(mobile), ...LEGACY_EMAIL_DOMAINS.map((d) => `${mobile}@${d}`)]
}

/**
 * True when an address is one of ours rather than something a customer typed.
 *
 * Exported because "is this a real address I can show, prefill or email?" is a question the rest of
 * the backend has to be able to ask, and answering it by pattern-matching a domain in each caller is
 * how the storefronts ended up with their own drifting copies — one of which has a regex missing a
 * backslash and therefore never matches anything.
 */
export function isSyntheticEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const [local, domain] = email.toLowerCase().split("@")
  if (!domain || !/^\d{10}$/.test(local)) return false
  return domain === EMAIL_DOMAIN || LEGACY_EMAIL_DOMAINS.includes(domain)
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

  /**
   * Every candidate is checked, not just the first that hits.
   *
   * Stopping early would be faster and would hide the one failure that matters: the same mobile
   * filed under two domains. The loop would quietly pick whichever came first and the other row —
   * with its own order history, and soon its own wallet balance — would become unreachable without
   * anything anywhere reporting a problem. There are no such pairs in the data today; this is here
   * so that if one ever appears it is loud rather than silent.
   */
  const matches: Array<{ email: string; customer: { id: string } }> = []
  for (const email of candidateEmails(mobile)) {
    const found = await customerService.retrieveRegisteredByEmail(email).catch(() => null)
    if (found) matches.push({ email, customer: found })
  }

  if (matches.length > 1) {
    console.error(
      `[session] mobile ${mobile} resolves to ${matches.length} customer rows ` +
        `(${matches.map((m) => `${m.email}=${m.customer.id}`).join(", ")}). ` +
        `Signing in as the first; the others are orphaned and need merging.`
    )
  }

  let customer: { id: string } | null = matches[0]?.customer ?? null
  const isNewUser = !customer

  if (!customer) {
    /**
     * The create is racy by nature, and the race is reachable: a double-tapped verify button, or a
     * storefront retry on a slow response, runs two of these for the same mobile at once. Both find
     * nothing, both create, and the unique index on (email, has_account) rejects the loser — which
     * would surface to a customer who typed the correct code as "something went wrong".
     *
     * So a failed create is treated as "somebody else just made it" and re-read before giving up.
     * If the row really is there, the outcome is identical to having won the race, which is what the
     * customer is entitled to. Only a create that fails with nothing to find afterwards is a genuine
     * error worth propagating.
     */
    try {
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
    } catch (error) {
      customer = await customerService
        .retrieveRegisteredByEmail(syntheticEmail(mobile))
        .catch(() => null)
      if (!customer) throw error
      console.warn(`[session] lost a create race for ${mobile}; using the row that won`)
    }
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
