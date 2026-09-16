import crypto from "crypto"

/**
 * Recognising the same delivery address twice.
 *
 * ── What this is for ───────────────────────────────────────────────────────────────────────────
 * One grant per verified mobile is already structural: one mobile is one customer row, and the
 * engine counts that customer's grants. What that does not catch is ten SIMs delivering to one
 * flat — the cheapest version of the attack, and the one the joining offer is most exposed to.
 *
 * ── Why a hash rather than the address itself ──────────────────────────────────────────────────
 * Comparing addresses needs only equality, not the text. Storing a digest beside a reward keeps the
 * customer's address in the one place it belongs — their order — instead of copying it into the
 * ledger, where it would sit forever in a table nobody thinks of as holding personal data. The
 * digest is salted with a server secret so it cannot be checked against a guessed address by
 * anybody who obtains the table.
 *
 * ── The limits, stated plainly ─────────────────────────────────────────────────────────────────
 * This matches addresses that are the same address written slightly differently. It does not defeat
 * somebody determined: adding a fictitious landmark or misspelling a road produces a different
 * digest, and no amount of normalising fixes that without also colliding flats 4 and 5 in the same
 * building — which would refuse thirty-nine honest neighbours to stop one fraudster. The cheap
 * attack is worth blocking here; the determined one is a job for the address clustering and the
 * earning caps in the fraud work, where a human can look at the pattern.
 */

/**
 * Filler that carries no distinguishing information.
 *
 * Deliberately short. Every word removed is a word that can no longer tell two addresses apart, and
 * house and flat numbers are exactly what separates neighbours — so the numbers are always kept and
 * only the labels around them go.
 */
const FILLER = new Set([
  "no", "number", "flat", "flt", "house", "hno", "apt", "apartment", "appt",
  "bldg", "building", "block", "floor", "flr", "near", "opp", "opposite", "behind",
  "the", "and", "road", "rd", "street", "st", "lane", "ln",
])

/**
 * Reduces an address to its distinguishing parts.
 *
 * Case, punctuation and spacing vary with whoever typed it; none of them mean anything. What
 * survives is the sequence of meaningful tokens, in order — order is kept because "4 12 mg" and
 * "12 4 mg" are genuinely different places, and sorting them would merge two addresses in the same
 * street into one.
 */
export function normaliseAddress(parts: {
  line1?: string | null
  line2?: string | null
  city?: string | null
  postalCode?: string | null
}): string {
  const raw = [parts.line1, parts.line2, parts.city, parts.postalCode]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  const tokens = raw
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !FILLER.has(t))

  return tokens.join(" ")
}

/**
 * A stable, non-reversible identifier for a delivery address.
 *
 * Returns null when there is not enough to identify anything. A blank or near-blank address must
 * never produce a digest, because every such order would share it and the first customer to check
 * out without an address would lock out everybody after them.
 */
export function addressFingerprint(parts: {
  line1?: string | null
  line2?: string | null
  city?: string | null
  postalCode?: string | null
}): string | null {
  const normalised = normaliseAddress(parts)

  /* Two tokens is the floor: a house number and something else. Below that the match would be
     accidental rather than meaningful. */
  if (normalised.length < 6 || normalised.split(" ").length < 2) return null

  const salt = process.env.ADDRESS_HASH_SALT ?? process.env.COOKIE_SECRET ?? ""
  if (!salt) {
    /* Refused rather than falling back to an unsalted digest. An unsalted hash of an address is
       reversible by anybody willing to hash the addresses in a pincode, which is all of them. */
    throw new Error("[wallet] ADDRESS_HASH_SALT is not set; cannot fingerprint an address")
  }

  return crypto.createHmac("sha256", salt).update(normalised).digest("hex").slice(0, 32)
}
