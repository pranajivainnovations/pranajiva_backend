/**
 * Storing and reading contact-form enquiries.
 *
 * The form that feeds this used to discard everything it collected while telling the sender it had
 * been received. The one rule this file exists to enforce is that the customer is told nothing
 * until the row has committed — see `createEnquiry`, which returns only after the INSERT.
 */

import crypto from "crypto"
import { Pool } from "pg"

let pool: Pool | null = null

/** Reuses Medusa's own DATABASE_URL — support lives in the same database as everything else. */
function getPool(): Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[support] DATABASE_URL is not set")
  pool = new Pool({ connectionString, max: 3 })
  return pool
}

export type Brand = "crossfriend" | "pranajiva"

/**
 * The subjects the form offers.
 *
 * Closed here rather than as a CHECK constraint so adding one is a one-line change, and closed at
 * all so a crafted request cannot store a subject no OPS screen knows how to show. Anything
 * unrecognised becomes "other" rather than being rejected — the message matters more than the
 * dropdown.
 */
export const SUBJECTS = [
  "product-inquiry",
  "order-status",
  "return-refund",
  "shipping",
  "technical-support",
  "partnership",
  "feedback",
  "other",
] as const

export class EnquiryError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = "EnquiryError"
  }
}

export interface EnquiryInput {
  brand: Brand
  name?: string
  email?: string
  phone?: string
  subject?: string
  message?: string
  customerId?: string | null
  /** Raw address; hashed before it is stored and never kept. */
  sourceIp?: string | null
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null
  const t = v.trim()
  if (!t) return null
  return t.slice(0, max)
}

/* Deliberately permissive. The job is to reject what cannot be replied to, not to argue with
   somebody about their own address — every stricter regex in circulation rejects deliverable
   addresses, and the cost of a false reject here is a lost customer. */
const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

/** Ten digits, however it was typed — +91, 91, spaces, dashes and all. */
const tenDigits = (raw: string): string | null => {
  const digits = raw.replace(/\D/g, "")
  const ten = digits.length > 10 ? digits.slice(-10) : digits
  return /^[6-9]\d{9}$/.test(ten) ? ten : null
}

/**
 * A stable, non-reversible fingerprint of the sender's address.
 *
 * Salted with the app's own secret so the same IP yields the same hash here and a useless one
 * anywhere else. Enough to rate-limit and to notice a flood; not a personal-data liability sitting
 * in a table support staff read all day.
 */
function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const salt = process.env.JWT_SECRET ?? "pranajiva-enquiry-salt"
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 64)
}

/** How many this sender has filed in the last hour. */
const FLOOD_WINDOW_MINUTES = 60
const FLOOD_LIMIT = 5

export interface StoredEnquiry {
  id: string
  createdAt: string
}

/**
 * Validate, rate-limit and store one enquiry.
 *
 * Throws EnquiryError with a message written for the person who filled the form — these strings
 * reach the page, so "Please add a message of at least 10 characters" rather than "message_too_short".
 */
export async function createEnquiry(input: EnquiryInput): Promise<StoredEnquiry> {
  const name = clean(input.name, 200)
  const message = clean(input.message, 5000)
  const rawEmail = clean(input.email, 320)
  const rawPhone = clean(input.phone, 32)

  if (!name) {
    throw new EnquiryError("name_required", "Please tell us your name.")
  }
  if (!message || message.length < 10) {
    throw new EnquiryError(
      "message_too_short",
      "Please add a little more detail — at least ten characters."
    )
  }

  const email = rawEmail && looksLikeEmail(rawEmail) ? rawEmail : null
  const phone = rawPhone ? tenDigits(rawPhone) : null

  if (rawEmail && !email) {
    throw new EnquiryError("email_invalid", "That email address does not look right.")
  }
  if (rawPhone && !phone) {
    throw new EnquiryError(
      "phone_invalid",
      "That mobile number does not look right — ten digits starting 6 to 9."
    )
  }

  /* Mirrors the enquiries_reachable_ck constraint, so the visitor gets a sentence rather than a
     database error. */
  if (!email && !phone) {
    throw new EnquiryError(
      "no_reply_route",
      "Please leave either an email address or a mobile number so we can reply."
    )
  }

  const subject =
    SUBJECTS.find((s) => s === clean(input.subject, 64)) ?? "other"
  const ipHash = hashIp(input.sourceIp)

  const db = getPool()

  if (ipHash) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM support.enquiries
        WHERE source_ip_hash = $1
          AND created_at > NOW() - ($2 || ' minutes')::interval`,
      [ipHash, String(FLOOD_WINDOW_MINUTES)]
    )
    if (Number(rows[0]?.n ?? 0) >= FLOOD_LIMIT) {
      throw new EnquiryError(
        "too_many",
        "You have sent us several messages already. We have them — please give us a little time to reply.",
        429
      )
    }
  }

  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO support.enquiries
       (brand, name, email, phone, subject, message, customer_id, source_ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      input.brand,
      name,
      email,
      phone,
      subject,
      message,
      input.customerId ?? null,
      ipHash,
    ]
  )

  return {
    id: String(rows[0].id),
    createdAt: rows[0].created_at.toISOString(),
  }
}

/** True when the table exists — lets the route answer 503 rather than 500 before the migration. */
export async function enquiriesReady(): Promise<boolean> {
  try {
    const { rows } = await getPool().query<{ table: string | null }>(
      `SELECT to_regclass('support.enquiries')::text AS table`
    )
    return Boolean(rows[0]?.table)
  } catch {
    return false
  }
}
