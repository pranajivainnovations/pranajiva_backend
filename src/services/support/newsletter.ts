import crypto from "crypto"
import { Pool } from "pg"

/**
 * Storing a "tell me when something new is ready" sign-up.
 *
 * ── What this does not do ────────────────────────────────────────────────────────────────────
 * It sends nothing. There is no mail service anywhere in this stack, so the row is the whole
 * outcome: an address to write to when there is news. Nothing here, and nothing that calls it, may
 * tell a visitor that a confirmation email is on its way.
 *
 * ── Why a repeat sign-up is a success and not an error ───────────────────────────────────────
 * Answering "that address is already on the list" tells whoever typed it something about a third
 * party: that this person signed up to this shop. The visitor gets the same sentence either way.
 */

let pool: Pool | null = null

function getPool(): Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[support] DATABASE_URL is not set")
  pool = new Pool({ connectionString, max: 3 })
  return pool
}

export type Brand = "crossfriend" | "pranajiva"

export class NewsletterError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = "NewsletterError"
  }
}

export interface NewsletterInput {
  brand: Brand
  email?: string
  source?: string
  customerId?: string | null
  sourceIp?: string | null
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null
  const t = v.trim()
  if (!t) return null
  return t.slice(0, max)
}

/* Deliberately permissive, matching enquiries and sample requests. */
const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

/* Where on the site the box was. Free text from a caller, so it is cut down to a short slug
   rather than trusted. */
const cleanSource = (v: unknown): string => {
  const t = clean(v, 64)?.toLowerCase().replace(/[^a-z0-9_-]/g, "")
  return t || "footer"
}

function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const salt = process.env.JWT_SECRET ?? "pranajiva-enquiry-salt"
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 64)
}

const FLOOD_WINDOW_MINUTES = 60
const FLOOD_LIMIT = 5

export async function subscribeToNewsletter(input: NewsletterInput): Promise<{ id: string }> {
  const rawEmail = clean(input.email, 320)
  const email = rawEmail && looksLikeEmail(rawEmail) ? rawEmail.toLowerCase() : null
  if (!email) {
    throw new NewsletterError(
      "email_invalid",
      rawEmail ? "That email address does not look right." : "Please enter your email address."
    )
  }

  const ipHash = hashIp(input.sourceIp)
  const db = getPool()

  if (ipHash) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM support.newsletter_subscribers
        WHERE source_ip_hash = $1
          AND created_at > NOW() - ($2 || ' minutes')::interval`,
      [ipHash, String(FLOOD_WINDOW_MINUTES)]
    )
    if (Number(rows[0]?.n ?? 0) >= FLOOD_LIMIT) {
      throw new NewsletterError(
        "too_many",
        "That is several sign-ups from one connection. Please try again later.",
        429
      )
    }
  }

  /* One statement, so two submissions of the same address at the same moment cannot both insert.
     On a repeat the row is kept as it was — same created_at, same source — except that somebody
     who had opted out and has now asked again is opted back in. RETURNING works on both paths. */
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO support.newsletter_subscribers
       (brand, email, source, customer_id, source_ip_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (brand, email)
     DO UPDATE SET unsubscribed_at = NULL
     RETURNING id`,
    [input.brand, email, cleanSource(input.source), input.customerId ?? null, ipHash]
  )

  if (!rows[0]?.id) {
    /* Not reachable with the statement above, but the caller reports success on return, and
       success must mean a stored row. */
    throw new Error("[support] newsletter sign-up returned no row")
  }

  return { id: String(rows[0].id) }
}

/** True when the table exists — lets the route answer 503 rather than 500 before the migration. */
export async function newsletterReady(): Promise<boolean> {
  try {
    const { rows } = await getPool().query<{ table: string | null }>(
      `SELECT to_regclass('support.newsletter_subscribers')::text AS table`
    )
    return Boolean(rows[0]?.table)
  } catch {
    return false
  }
}
