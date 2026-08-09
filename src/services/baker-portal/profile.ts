import { getBakerNetworkDbPool } from "../baker-network/db"

/**
 * Baker-editable profile fields.
 *
 * The whole point of this file is the ALLOWLIST below. OPS can edit ~30 columns on a bakery; a
 * baker may edit far fewer, and the difference is not cosmetic:
 *
 *   is_public                     whether they are listed at all
 *   blue_tick / trust_badge       verification — a self-granted badge is worthless
 *   featured_priority             placement ranking
 *   status / is_active            their standing in the network
 *   slug                          their public URL; changing it breaks every shared link
 *   public_id                     immutable, enforced by a database trigger
 *
 * None of those are reachable from here. The update is built from a fixed map rather than from the
 * request body, so a field that is not in the map cannot be written no matter what is posted —
 * adding a column to the table does not silently make it baker-editable.
 *
 * This exists because the OPS team cannot be the write path for every bakery's phone number as the
 * network grows. Letting bakers maintain their own details is the only version of this that scales.
 */

export interface BakerProfileInput {
  name?: string
  contactPerson?: string
  phone?: string
  whatsappNumber?: string
  email?: string
  address?: string
  bio?: string
  websiteUrl?: string
  avgTurnaroundHours?: number | null
  specialtyTags?: string[]
}

/** field -> column. Anything absent here is not editable by a baker, by construction. */
const EDITABLE: Record<keyof BakerProfileInput, string> = {
  name: "name",
  contactPerson: "contact_person",
  phone: "phone",
  whatsappNumber: "whatsapp_number",
  email: "email",
  address: "address",
  bio: "bio",
  websiteUrl: "website_url",
  avgTurnaroundHours: "avg_turnaround_hours",
  specialtyTags: "specialty_tags",
}

const LIMITS = {
  name: 120,
  contactPerson: 120,
  phone: 20,
  whatsappNumber: 20,
  email: 255,
  address: 500,
  bio: 2000,
  websiteUrl: 500,
}

/** Messages are written for a baker to read, not for a developer. */
export function validateBakerProfile(input: BakerProfileInput): string | null {
  if (input.name !== undefined && !input.name.trim()) {
    return "Your bakery needs a name."
  }
  for (const [field, max] of Object.entries(LIMITS) as [keyof typeof LIMITS, number][]) {
    const value = input[field]
    if (typeof value === "string" && value.length > max) {
      return `That ${field === "bio" ? "description" : "value"} is too long — keep it under ${max} characters.`
    }
  }
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email.trim())) {
    return "That email address doesn't look right."
  }
  if (input.websiteUrl && !/^https?:\/\/.+/i.test(input.websiteUrl.trim())) {
    return "Your website should start with http:// or https://"
  }
  if (
    input.avgTurnaroundHours != null &&
    (!Number.isFinite(input.avgTurnaroundHours) ||
      input.avgTurnaroundHours < 0 ||
      input.avgTurnaroundHours > 720)
  ) {
    return "Turnaround should be between 0 and 720 hours."
  }
  if (input.specialtyTags && input.specialtyTags.length > 12) {
    return "You can add up to 12 specialities."
  }
  return null
}

export async function updateBakerProfile(
  bakerId: string,
  input: BakerProfileInput
): Promise<void> {
  const error = validateBakerProfile(input)
  if (error) throw new Error(error)

  const sets: string[] = []
  const params: unknown[] = []

  for (const [field, column] of Object.entries(EDITABLE) as [keyof BakerProfileInput, string][]) {
    const value = input[field]
    if (value === undefined) continue

    params.push(
      // Empty strings become NULL so "cleared" and "never set" look the same downstream — the
      // storefront already treats NULL as "don't render this".
      typeof value === "string" ? (value.trim() || null) : value
    )
    sets.push(`${column} = $${params.length}`)
  }

  if (sets.length === 0) return

  params.push(bakerId)
  const db = getBakerNetworkDbPool()
  await db.query(
    `UPDATE baker_network.bakers SET ${sets.join(", ")}, updated_at = NOW()
      WHERE id = $${params.length}`,
    params
  )
}

/**
 * Records an uploaded profile or banner image.
 *
 * `profile` and `banner` are "most recent wins" singles, so the previous row is replaced rather
 * than accumulated — otherwise a baker who re-uploads three times leaves two orphans that the
 * public page might pick instead. The S3 objects are deliberately left in place; storage is cheap
 * and an accidental overwrite stays recoverable.
 *
 * `profile_photo_url` on bakers is kept in step because the directory endpoint reads that column
 * directly and would otherwise show a stale avatar next to a fresh profile page.
 */
export async function saveBakerImage(
  bakerId: string,
  purpose: "profile" | "banner",
  url: string,
  s3Key: string
): Promise<void> {
  const db = getBakerNetworkDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")
    await client.query(
      `DELETE FROM baker_network.baker_images WHERE baker_id = $1 AND purpose = $2`,
      [bakerId, purpose]
    )
    await client.query(
      `INSERT INTO baker_network.baker_images (baker_id, purpose, s3_key, url)
       VALUES ($1, $2, $3, $4)`,
      [bakerId, purpose, s3Key, url]
    )
    if (purpose === "profile") {
      await client.query(
        `UPDATE baker_network.bakers SET profile_photo_url = $1, updated_at = NOW() WHERE id = $2`,
        [url, bakerId]
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
