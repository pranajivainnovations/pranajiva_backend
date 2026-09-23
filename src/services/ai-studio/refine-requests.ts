import { getWalletDbPool } from "../wallet/db"

/**
 * Asking us to refine a design, and the queue that arrives in.
 *
 * ── Why this is worth building rather than an email link ───────────────────────────────────────
 * An email link produces a mailbox nobody measures. This produces a count: how many people wanted
 * something the Studio could not give them, what they asked for in their own words, and whether
 * anybody answered. That count is the clearest read available on what the generator is missing —
 * clearer than generation volume, which says people tried, not what they were trying for.
 *
 * ── Why a duplicate is not an error the customer sees ──────────────────────────────────────────
 * Someone who taps the button twice, or comes back an hour later because nobody has called, has done
 * nothing wrong. The database allows one open request per customer, and a second submission updates
 * the message on the first rather than being refused. They are told we already have it — which is
 * true, and kinder than "you have already asked".
 */

export interface RefineRequestInput {
  customerId: string
  message: string
  contact?: string | null
  generationId?: string | null
  designId?: string | null
}

export interface RefineRequest {
  id: string
  status: "open" | "handled" | "closed"
  createdAt: string
  /** True when this updated an existing open request instead of opening a new one. */
  alreadyOpen: boolean
}

const MAX_MESSAGE = 1000

/**
 * Record a request, or fold it into the one they already have open.
 *
 * The insert relies on the partial unique index rather than checking first: a check-then-insert
 * loses the race a double-tapped button creates, and this is a button people double-tap because
 * nothing visible happens for a moment after the first press.
 */
export async function submitRefineRequest(
  input: RefineRequestInput
): Promise<RefineRequest> {
  const pool = getWalletDbPool()
  const message = input.message.trim().slice(0, MAX_MESSAGE)
  const contact = input.contact?.trim() || null

  const { rows } = await pool.query(
    `INSERT INTO ai_studio.refine_requests
       (customer_id, message, contact, generation_id, design_id)
     VALUES ($1, $2, $3, $4::uuid, $5::uuid)
     ON CONFLICT (customer_id) WHERE status = 'open'
     DO UPDATE SET
       message    = EXCLUDED.message,
       contact    = COALESCE(EXCLUDED.contact, ai_studio.refine_requests.contact),
       /* Keep whichever design they last pointed at, rather than blanking it on a bare follow-up. */
       generation_id = COALESCE(EXCLUDED.generation_id, ai_studio.refine_requests.generation_id),
       design_id     = COALESCE(EXCLUDED.design_id, ai_studio.refine_requests.design_id)
     RETURNING id, status, created_at,
               (xmax <> 0) AS already_open`,
    [
      input.customerId,
      message,
      contact,
      input.generationId || null,
      input.designId || null,
    ]
  )

  return {
    id: rows[0].id,
    status: rows[0].status,
    createdAt: rows[0].created_at,
    /* xmax is non-zero on a row the statement updated rather than inserted — Postgres's own record
       of which branch of the upsert ran, rather than a second query to find out. */
    alreadyOpen: rows[0].already_open === true,
  }
}

/** The one request this customer has open, if any — so the page can say "we have this already". */
export async function getOpenRequest(
  customerId: string
): Promise<{ id: string; message: string; createdAt: string } | null> {
  const pool = getWalletDbPool()

  const { rows } = await pool.query(
    `SELECT id, message, created_at
       FROM ai_studio.refine_requests
      WHERE customer_id = $1 AND status = 'open'
      LIMIT 1`,
    [customerId]
  )

  if (!rows.length) return null
  return { id: rows[0].id, message: rows[0].message, createdAt: rows[0].created_at }
}
