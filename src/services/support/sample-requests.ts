/**
 * Storing free-sample requests.
 *
 * Same rule as `enquiries`: the visitor is told nothing until the row has committed. A form that
 * says "your sample is on the way" without a row to prove it is the bug this stack already had once.
 *
 * ── What is free and what is not ───────────────────────────────────────────────────────────────
 * The sachet is free and so is the postage. That makes this the one public endpoint on the site
 * that spends money per submission, which is why the limit below is a database constraint rather
 * than a policy.
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
 * The products a sample can be requested for.
 *
 * Closed here, and checked, for two reasons. A crafted request must not be able to store a handle
 * no OPS screen can resolve and no stock room recognises. And the twelve gift hampers in the
 * catalogue are not sampleable — a hamper is the gift, so "send me a free one" is an order, not a
 * sample. These six are the single products, all powders and oils, which sachet.
 *
 * Adding one is a line here plus a line in the storefront's list. Deliberately not read from the
 * catalogue at runtime: every new product would then silently become free to request, which is the
 * wrong default for the one endpoint that costs money.
 */
export const SAMPLEABLE_HANDLES = [
  "tila-abhyanga-oil",
  "herbal-hair-cleanse-powder",
  "beetroot-face-pack",
  "herbal-body-ubtan",
  "neem-powder",
  "moringa-powder",
] as const

/** The statuses OPS moves a request through. Kept out of the database on purpose. */
export const SAMPLE_STATUSES = ["new", "approved", "dispatched", "rejected"] as const

export class SampleRequestError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = "SampleRequestError"
  }
}

export interface SampleRequestInput {
  brand: Brand
  name?: string
  phone?: string
  email?: string
  productHandle?: string
  addressLine1?: string
  addressLine2?: string
  landmark?: string
  city?: string
  state?: string
  pincode?: string
  reason?: string
  marketingOptIn?: boolean
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

/* Deliberately permissive, matching enquiries. The job is to reject what cannot be reached, not to
   argue with somebody about their own address. */
const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

/** Ten digits, however it was typed — +91, 91, spaces, dashes and all. */
const tenDigits = (raw: string): string | null => {
  const digits = raw.replace(/\D/g, "")
  const ten = digits.length > 10 ? digits.slice(-10) : digits
  return /^[6-9]\d{9}$/.test(ten) ? ten : null
}

/** Six digits, not starting zero — no Indian pincode does. */
const sixDigitPincode = (raw: string): string | null => {
  const digits = raw.replace(/\D/g, "")
  return /^[1-9]\d{5}$/.test(digits) ? digits : null
}

/**
 * A stable, non-reversible fingerprint of the sender's address.
 *
 * Salted with the app's own secret so the same IP yields the same hash here and a useless one
 * anywhere else. Identical to the enquiries implementation on purpose: the same visitor filling
 * both forms produces the same hash, so a flood is visible across both.
 */
function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const salt = process.env.JWT_SECRET ?? "pranajiva-enquiry-salt"
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 64)
}

const FLOOD_WINDOW_MINUTES = 60
const FLOOD_LIMIT = 3

export interface StoredSampleRequest {
  id: string
  createdAt: string
}

/**
 * Validate, rate-limit and store one sample request.
 *
 * Throws SampleRequestError with a message written for the person who filled the form — these
 * strings reach the page, so "That pincode does not look right" rather than "pincode_invalid".
 */
export async function createSampleRequest(
  input: SampleRequestInput
): Promise<StoredSampleRequest> {
  const name = clean(input.name, 200)
  const rawPhone = clean(input.phone, 32)
  const rawEmail = clean(input.email, 320)
  const rawPincode = clean(input.pincode, 12)
  const addressLine1 = clean(input.addressLine1, 300)
  const city = clean(input.city, 120)
  const state = clean(input.state, 120)

  if (!name) {
    throw new SampleRequestError("name_required", "Please tell us your name.")
  }

  const phone = rawPhone ? tenDigits(rawPhone) : null
  if (!phone) {
    throw new SampleRequestError(
      "phone_invalid",
      "Please give a mobile number we can reach you on — ten digits starting 6 to 9."
    )
  }

  const email = rawEmail && looksLikeEmail(rawEmail) ? rawEmail : null
  if (!email) {
    throw new SampleRequestError(
      "email_invalid",
      rawEmail
        ? "That email address does not look right."
        : "Please give an email address so we can confirm what we have sent."
    )
  }

  const productHandle = SAMPLEABLE_HANDLES.find((h) => h === clean(input.productHandle, 160))
  if (!productHandle) {
    throw new SampleRequestError(
      "product_invalid",
      "Please choose which sample you would like from the list."
    )
  }

  if (!addressLine1) {
    throw new SampleRequestError(
      "address_required",
      "Please give a street address we can post the sachet to."
    )
  }

  const pincode = rawPincode ? sixDigitPincode(rawPincode) : null
  if (!pincode) {
    throw new SampleRequestError("pincode_invalid", "That pincode does not look right.")
  }

  if (!city || !state) {
    throw new SampleRequestError(
      "city_state_required",
      "Please add the town and state — entering your pincode usually fills these in."
    )
  }

  const ipHash = hashIp(input.sourceIp)
  const db = getPool()

  /**
   * One per phone number, checked here so the visitor gets an explanation.
   *
   * The UNIQUE index on (brand, phone) is what actually enforces it — this check loses a race
   * between two concurrent submissions, and the insert below catches that case separately.
   */
  const { rows: existing } = await db.query<{ created_at: Date }>(
    `SELECT created_at FROM support.sample_requests
      WHERE brand = $1 AND phone = $2
      LIMIT 1`,
    [input.brand, phone]
  )
  if (existing.length) {
    throw new SampleRequestError(
      "already_requested",
      "We have already sent a sample to this mobile number. It is one per person so that we can keep offering it — if yours never arrived, please message us and we will sort it out.",
      409
    )
  }

  if (ipHash) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM support.sample_requests
        WHERE source_ip_hash = $1
          AND created_at > NOW() - ($2 || ' minutes')::interval`,
      [ipHash, String(FLOOD_WINDOW_MINUTES)]
    )
    if (Number(rows[0]?.n ?? 0) >= FLOOD_LIMIT) {
      throw new SampleRequestError(
        "too_many",
        "That is several sample requests from one connection. If you are ordering for other people, please message us instead and we will help.",
        429
      )
    }
  }

  try {
    const { rows } = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO support.sample_requests
         (brand, name, phone, email, product_handle,
          address_line1, address_line2, landmark, city, state, pincode,
          reason, marketing_opt_in, customer_id, source_ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, created_at`,
      [
        input.brand,
        name,
        phone,
        email,
        productHandle,
        addressLine1,
        clean(input.addressLine2, 300),
        clean(input.landmark, 200),
        city,
        state,
        pincode,
        clean(input.reason, 2000),
        Boolean(input.marketingOptIn),
        input.customerId ?? null,
        ipHash,
      ]
    )

    return {
      id: String(rows[0].id),
      createdAt: rows[0].created_at.toISOString(),
    }
  } catch (error) {
    /* 23505 is unique_violation: the race the check above cannot win. The visitor gets the same
       sentence either way, which is the point of catching it rather than letting it 500. */
    if ((error as { code?: string })?.code === "23505") {
      throw new SampleRequestError(
        "already_requested",
        "We have already sent a sample to this mobile number. It is one per person so that we can keep offering it — if yours never arrived, please message us and we will sort it out.",
        409
      )
    }
    throw error
  }
}

/** True when the table exists — lets the route answer 503 rather than 500 before the migration. */
export async function sampleRequestsReady(): Promise<boolean> {
  try {
    const { rows } = await getPool().query<{ table: string | null }>(
      `SELECT to_regclass('support.sample_requests')::text AS table`
    )
    return Boolean(rows[0]?.table)
  } catch {
    return false
  }
}
