import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"
import { dueAtFor, nextOccurrence, queueNextDelivery, type RepeatRule } from "../../../../services/reminders/schedule"

/**
 * GET  /store/crossfriend/reminders   — everything this customer asked to be reminded about
 * POST /store/crossfriend/reminders   — remember something new
 *
 * Auth required and scoped to the owner on every query. A reminder carries whatever somebody chose
 * to write about their own life, and often about other people's, so there is no listing that is not
 * filtered by customer_id — not as a convenience, but because the alternative is a leak.
 */

const MAX_TITLE = 120
const MAX_NOTES = 2000

interface Body {
  title?: unknown
  notes?: unknown
  eventDate?: unknown
  repeatRule?: unknown
  leadDays?: unknown
}

/** ISO calendar date and nothing else — a Date parse here would accept far too much. */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split("-").map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  // Rejects 31 April and 30 February rather than letting them roll into the next month later.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id
  if (!customerId) {
    res.status(401).json({ error: "Please sign in to see your reminders." })
    return
  }

  try {
    const { rows } = await getBakerNetworkDbPool().query(
      /**
       * The reminder plus the state of its next delivery, in one query.
       *
       * The delivery state is what makes this trustworthy rather than merely present: "we will tell
       * you on the 11th" and "we tried and there was no device to send to" are different facts, and
       * a list that showed neither would be a list of promises with no evidence behind them.
       */
      `SELECT r.id, r.title, r.notes, r.event_date, r.repeat_rule, r.lead_days, r.is_active,
              r.created_at,
              d.occurrence_date AS next_occurrence,
              d.due_at          AS next_due_at,
              last.sent_at      AS last_sent_at,
              last.status       AS last_status,
              last.last_error   AS last_error
         FROM crossfriend.reminders r
         LEFT JOIN LATERAL (
           SELECT occurrence_date, due_at
             FROM crossfriend.reminder_deliveries
            WHERE reminder_id = r.id AND status = 'pending'
            ORDER BY due_at
            LIMIT 1
         ) d ON TRUE
         LEFT JOIN LATERAL (
           SELECT sent_at, status, last_error
             FROM crossfriend.reminder_deliveries
            WHERE reminder_id = r.id AND status <> 'pending'
            ORDER BY occurrence_date DESC
            LIMIT 1
         ) last ON TRUE
        WHERE r.customer_id = $1
        ORDER BY d.due_at NULLS LAST, r.event_date`,
      [customerId]
    )

    res.json({
      reminders: rows.map((r) => ({
        id: r.id,
        title: r.title,
        notes: r.notes ?? "",
        eventDate: new Date(r.event_date).toISOString().slice(0, 10),
        repeatRule: r.repeat_rule,
        leadDays: r.lead_days,
        isActive: r.is_active,
        nextOccurrence: r.next_occurrence
          ? new Date(r.next_occurrence).toISOString().slice(0, 10)
          : null,
        nextDueAt: r.next_due_at ? new Date(r.next_due_at).toISOString() : null,
        lastSentAt: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null,
        lastStatus: r.last_status ?? null,
        lastError: r.last_error ?? null,
      })),
    })
  } catch (error) {
    console.error("[reminders] list failed", error)
    res.status(500).json({ error: "Could not load your reminders." })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id
  if (!customerId) {
    res.status(401).json({ error: "Please sign in to create a reminder." })
    return
  }

  const body = (req.body ?? {}) as Body

  const title = typeof body.title === "string" ? body.title.trim() : ""
  if (!title) {
    res.status(400).json({ error: "Give the reminder a name." })
    return
  }
  if (title.length > MAX_TITLE) {
    res.status(400).json({ error: `The name must be under ${MAX_TITLE} characters.` })
    return
  }

  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, MAX_NOTES) : ""

  if (!isCalendarDate(body.eventDate)) {
    res.status(400).json({ error: "Pick a valid date." })
    return
  }

  const repeatRule: RepeatRule = body.repeatRule === "yearly" ? "yearly" : "once"

  const leadDays = Number(body.leadDays ?? 0)
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 30) {
    res.status(400).json({ error: "Remind me between 0 and 30 days before." })
    return
  }

  /**
   * A one-off in the past has nothing to send, and saying so at creation is the point.
   *
   * The strategy note is explicit that a reminder must confirm clearly when it is created. Silently
   * accepting one that can never fire is the exact failure that teaches somebody the feature does
   * not work — and they would only discover it by the notification never arriving.
   */
  if (!nextOccurrence(body.eventDate, repeatRule, leadDays)) {
    res.status(400).json({
      error:
        leadDays > 0
          ? "That date has already passed, or is too soon for this much notice."
          : "That date has already passed.",
    })
    return
  }

  try {
    const pool = getBakerNetworkDbPool()
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO crossfriend.reminders (customer_id, title, notes, event_date, repeat_rule, lead_days)
       VALUES ($1, $2, $3, $4::date, $5, $6)
       RETURNING id`,
      [customerId, title, notes || null, body.eventDate, repeatRule, leadDays]
    )

    const id = rows[0].id
    await queueNextDelivery(pool, id)

    const occurrence = nextOccurrence(body.eventDate, repeatRule, leadDays)
    res.json({
      id,
      // Echoed back so the screen can confirm the exact moment rather than restating the input.
      nextDueAt: occurrence ? dueAtFor(occurrence, leadDays).toISOString() : null,
    })
  } catch (error) {
    console.error("[reminders] create failed", error)
    res.status(500).json({ error: "Could not save that reminder." })
  }
}
