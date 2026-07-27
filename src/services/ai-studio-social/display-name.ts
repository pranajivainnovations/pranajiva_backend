/**
 * Public-facing display names for the Like/Comment features.
 *
 * Real names are always preferred. Falls back to a themed, deterministic
 * generated name when `first_name` is missing OR when it's actually the
 * raw mobile number stored during OTP signup (`src/app/api/auth/otp/verify`
 * on the frontend sets first_name = mobile) — otherwise every public
 * comment would leak the commenter's phone number.
 *
 * Deterministic per customer id, so the same user always sees the same
 * generated name rather than a new one on every comment.
 */

const ADJECTIVES = [
  "Joyful", "Sweet", "Sparkling", "Delightful", "Cheerful",
  "Blissful", "Radiant", "Whimsical", "Charming", "Merry",
]

const NOUNS = [
  "Baker", "Celebrator", "Creator", "Dreamer", "Artist",
  "Host", "Planner", "Enthusiast", "Maker", "Storyteller",
]

const MOBILE_PATTERN = /^[6-9]\d{9}$/

function looksLikeMobileNumber(value: string): boolean {
  return MOBILE_PATTERN.test(value.trim())
}

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash
}

export function getDisplayName(customer: {
  id: string
  first_name?: string | null
  last_name?: string | null
}): string {
  const firstName = customer.first_name?.trim()

  if (firstName && !looksLikeMobileNumber(firstName)) {
    const lastInitial = customer.last_name?.trim()?.charAt(0)
    return lastInitial ? `${firstName} ${lastInitial}.` : firstName
  }

  const hash = hashString(customer.id)
  const adjective = ADJECTIVES[hash % ADJECTIVES.length]
  const noun = NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length]
  const suffix = (hash % 90) + 10 // 2-digit number, 10-99

  return `${adjective} ${noun} ${suffix}`
}
