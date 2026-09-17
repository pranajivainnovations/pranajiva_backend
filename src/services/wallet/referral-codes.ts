import crypto from "crypto"

import { getWalletDbPool } from "./db"

/**
 * The code a customer shares.
 *
 * ── What this is and is not ────────────────────────────────────────────────────────────────────
 * A code is a pointer to a customer and nothing else. It confers no authority: knowing somebody's
 * code lets you say they referred you, which is a claim that only ever moves money towards them.
 * That asymmetry is why guessing one is not worth defending against beyond making it impractical —
 * the attacker's reward for a successful guess is to give a stranger a small amount of credit.
 *
 * ── Why the alphabet has holes in it ───────────────────────────────────────────────────────────
 * Vowels are gone so a random draw cannot spell a word; 0/O and 1/I/L are gone because they are what
 * people get wrong reading a code off a screenshot. Twenty-eight symbols, eight of them: about 38
 * bits, or roughly one in 377 billion per guess.
 */

/** Twenty-eight symbols: digits 2–9 and the consonants, less the ones that look like each other. */
const ALPHABET = "23456789BCDFGHJKMNPQRSTVWXYZ"
const LENGTH = 8

/**
 * Enough attempts that a collision cannot realistically exhaust them, few enough that a genuine
 * fault — the table gone, the constraint changed — surfaces as an error instead of a hot loop.
 */
const MAX_ATTEMPTS = 5

/**
 * A fresh code.
 *
 * `randomInt` rather than `Math.random` scaled, and rather than a byte modulo the alphabet length:
 * 256 is not a multiple of 28, so `byte % 28` would make the first twelve symbols meaningfully more
 * likely than the rest. It is not an attack here, but a biased generator is the kind of thing that
 * gets copied into somewhere it does matter.
 */
export function generateCode(): string {
  let code = ""
  for (let i = 0; i < LENGTH; i++) {
    code += ALPHABET[crypto.randomInt(0, ALPHABET.length)]
  }
  return code
}

/**
 * What somebody typed, turned into what might be a code.
 *
 * People paste codes with spaces, hyphens and the odd trailing full stop, and they type them in
 * whatever case their keyboard was in. None of that is a different code. What this deliberately does
 * not do is guess at substitutions — an O is not silently read as a zero, because zero is not in the
 * alphabet and inventing a correction would mean a mistyped code could resolve to somebody else's.
 */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/**
 * This customer's code, minted on first ask.
 *
 * ── Why lazily, rather than at signup ──────────────────────────────────────────────────────────
 * Most customers never share anything. Issuing a code to every account writes a row per signup for a
 * feature a minority use, and — more to the point — makes the referral screen's first load the only
 * place a code could be missing, which is exactly the path that then goes untested. Minting on
 * demand means there is one code path and it runs every time.
 *
 * ── The race, and why ON CONFLICT rather than a caught error ───────────────────────────────────
 * Two tabs open the referral screen together and both find no code. A caught unique violation would
 * work here and be wrong elsewhere: inside a transaction a 23505 aborts the whole thing, so catching
 * it leaves the caller holding a dead transaction that fails at COMMIT for reasons nowhere near the
 * code that caused it. DO NOTHING never raises, so this is safe to call from inside one.
 *
 * A miss can mean either of two things — the code collided, or the other tab won — and they need
 * opposite responses, so the read-back distinguishes them rather than assuming.
 */
export async function getOrCreateCode(customerId: string): Promise<string> {
  const pool = getWalletDbPool()

  const existing = await pool.query(
    `SELECT code FROM wallet.referral_codes WHERE customer_id = $1`,
    [customerId]
  )
  if (existing.rowCount) return existing.rows[0].code

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { rows } = await pool.query(
      `INSERT INTO wallet.referral_codes (code, customer_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING code`,
      [generateCode(), customerId]
    )
    if (rows.length) return rows[0].code

    /* Somebody else may have been the somebody else. */
    const mine = await pool.query(
      `SELECT code FROM wallet.referral_codes WHERE customer_id = $1`,
      [customerId]
    )
    if (mine.rowCount) return mine.rows[0].code
  }

  throw new Error(
    `Could not mint a referral code for ${customerId} after ${MAX_ATTEMPTS} attempts`
  )
}

/** Whose code this is, or null. Accepts whatever the customer typed. */
export async function resolveCode(input: string): Promise<string | null> {
  const code = normaliseCode(input)
  if (!code) return null

  const { rows } = await getWalletDbPool().query(
    `SELECT customer_id FROM wallet.referral_codes WHERE code = $1`,
    [code]
  )
  return rows[0]?.customer_id ?? null
}
