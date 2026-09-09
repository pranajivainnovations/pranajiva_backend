import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getBakerNetworkDbPool } from "../../../../../services/baker-network/db"
import {
  clearPendingDeliveries,
  nextOccurrence,
  queueNextDelivery,
  type RepeatRule,
} from "../../../../../services/reminders/schedule"

/**
 * POST   /store/crossfriend/reminders/:id  — edit, or pause
 * DELETE /store/crossfriend/reminders/:id  — forget it entirely
 *
 * Both scoped to the owner in the WHERE clause rather than by checking first and acting after. A
 * reminder that exists but belongs to somebody else answers 404, not 403, so this cannot be used to
 * discover which ids are real.
 */

const MAX_TITLE = 120
const MAX_NOTES = 2000

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split("-").map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id
  if (!customerId) {
    res.status(401).json({ error: "Please sign in." })
    return
  }

  const pool = getBakerNetworkDbPool()

  const { rows: existingRows } = await pool.query(
    `SELECT id, title, notes, event_date, repeat_rule, lead_days, is_active
       FROM crossfriend.reminders
      WHERE id = $1 AND customer_id = $2`,
    [req.params.id, customerId]
  )
  const existing = existingRows[0]
  if (!existing) {
    res.status(404).json({ error: "Reminder not found." })
    return
  }

  const body = (req.body ?? {}) as Record<string, unknown>

  /* Every field is optional — this endpoint serves both "change the date" and the pause toggle, and
     a partial update should not require the caller to send back fields it is not touching. */
  const title = typeof body.title === "string" ? body.title.trim() : existing.title
  const notes =
    typeof body.notes === "string" ? body.notes.trim().slice(0, MAX_NOTES) : existing.notes
  const eventDate = isCalendarDate(body.eventDate)
    ? body.eventDate
    : new Date(existing.event_date).toISOString().slice(0, 10)
  const repeatRule: RepeatRule =
    body.repeatRule === "yearly" || body.repeatRule === "once"
      ? body.repeatRule
      : (existing.repeat_rule as RepeatRule)
  const leadDays =
    Number.isInteger(body.leadDays) && (body.leadDays as number) >= 0 && (body.leadDays as number) <= 30
      ? (body.leadDays as number)
      : existing.lead_days
  const isActive = typeof body.isActive === "boolean" ? body.isActive : existing.is_active

  if (!title) {
    res.status(400).json({ error: "Give the reminder a name." })
    return
  }
  if (title.length > MAX_TITLE) {
    res.status(400).json({ error: `The name must be under ${MAX_TITLE} characters.` })
    return
  }

  /* Only checked when it is still meant to fire. A paused reminder is allowed to sit in the past —
     that is often exactly why it was paused. */
  if (isActive && !nextOccurrence(eventDate, repeatRule, leadDays)) {
    res.status(400).json({ error: "That date has already passed, or is too soon for this much notice." })
    return
  }

  try {
    await pool.query(
      `UPDATE crossfriend.reminders
          SET title = $2, notes = $3, event_date = $4::date, repeat_rule = $5,
              lead_days = $6, is_active = $7, updated_at = NOW()
        WHERE id = $1 AND customer_id = $8`,
      [req.params.id, title, notes || null, eventDate, repeatRule, leadDays, isActive, customerId]
    )

    /**
     * Re-queue from scratch rather than trying to patch the pending row.
     *
     * The occurrence itself may have moved — a date change, a different lead time, a switch from
     * yearly to once — and the unique constraint means the old row cannot simply be updated into the
     * new one. Clearing only pending rows leaves the delivery history intact, which is the part that
     * has to stay true.
     */
    await clearPendingDeliveries(pool, req.params.id)
    if (isActive) await queueNextDelivery(pool, req.params.id)

    res.json({ ok: true })
  } catch (error) {
    console.error("[reminders] update failed", error)
    res.status(500).json({ error: "Could not save that change." })
  }
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.user?.customer_id
  if (!customerId) {
    res.status(401).json({ error: "Please sign in." })
    return
  }

  try {
    /* A hard delete, and the deliveries cascade with it. Unlike a board message, nothing else refers
       to a reminder — and the notes field may hold a third party's details, so "deleted" has to mean
       gone rather than hidden. */
    const result = await getBakerNetworkDbPool().query(
      `DELETE FROM crossfriend.reminders WHERE id = $1 AND customer_id = $2`,
      [req.params.id, customerId]
    )

    if (result.rowCount === 0) {
      res.status(404).json({ error: "Reminder not found." })
      return
    }

    res.json({ ok: true })
  } catch (error) {
    console.error("[reminders] delete failed", error)
    res.status(500).json({ error: "Could not delete that reminder." })
  }
}
