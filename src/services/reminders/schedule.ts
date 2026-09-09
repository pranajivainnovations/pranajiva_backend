import type { Pool } from "pg"

/**
 * Working out when a reminder should be sent, and writing that down.
 *
 * All the date arithmetic in the Assistant lives here rather than being spread across the routes and
 * the job. There is exactly one correct answer to "when does this go out", and it has to be the same
 * answer whether it is being computed at creation, after an edit, or by the drain preparing next
 * year — three places that would otherwise drift apart and produce a reminder that arrives on the
 * wrong day for reasons nobody can reproduce.
 */

/**
 * Nine in the morning, India time.
 *
 * Fixed rather than configurable, deliberately: a per-reminder send time is a preference nobody asks
 * for until they have used the thing for a year, and it doubles the states this file has to reason
 * about. Nine is early enough to act on a birthday and late enough not to be the thing that wakes
 * somebody.
 *
 * India time and not the server's, which runs in UTC — a reminder that fires at 09:00 UTC would
 * arrive at half past two in the afternoon, which is not what "the morning of" means to anyone here.
 * India has had no daylight saving since 1945, so the offset is a constant rather than a lookup.
 */
export const SEND_HOUR_IST = 9
const IST_OFFSET = "+05:30"

/** "2026-03-14" → { year: 2026, month: 3, day: 14 }, without touching the local timezone. */
function parts(isoDate: string): { year: number; month: number; day: number } {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number)
  return { year, month, day }
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/** Days in a month, so 29 February and 31 April can be resolved rather than silently rolling over. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The same month and day in a given year, clamped to the end of the month if it does not exist.
 *
 * 29 February is the case this exists for. A birthday on the 29th has to happen every year, not
 * three years in four, and JavaScript's date constructor would quietly turn it into 1 March —
 * arriving a day late, every non-leap year, in a way nobody would think to test.
 */
function sameDayIn(year: number, month: number, day: number): string {
  const clamped = Math.min(day, daysInMonth(year, month))
  return `${year}-${pad(month)}-${pad(clamped)}`
}

/** Shifts an ISO date by a whole number of days, in UTC so no zone can round it. */
function shiftDays(isoDate: string, days: number): string {
  const { year, month, day } = parts(isoDate)
  const shifted = new Date(Date.UTC(year, month - 1, day - days))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * The exact instant a reminder for this occurrence should be sent.
 *
 * Resolved to an absolute moment here and stored that way, so nothing downstream — the drain, the
 * log, the screen showing "next: Tuesday" — has to know which zone it was written in.
 */
export function dueAtFor(occurrenceDate: string, leadDays: number): Date {
  const sendDate = shiftDays(occurrenceDate, leadDays)
  return new Date(`${sendDate}T${pad(SEND_HOUR_IST)}:00:00${IST_OFFSET}`)
}

export type RepeatRule = "once" | "yearly"

/**
 * The next occurrence whose send time has not already passed, or null if there is none.
 *
 * Tested against the *send* time rather than the event date, which is the subtlety worth naming: a
 * birthday next Tuesday with three days' lead is already too late to schedule if today is Monday.
 * Comparing event dates would queue it and then fire it immediately, which reads as a bug to the
 * person receiving a "in 3 days" notification about something happening tomorrow.
 */
export function nextOccurrence(
  eventDate: string,
  repeatRule: RepeatRule,
  leadDays: number,
  after: Date = new Date()
): string | null {
  const { year, month, day } = parts(eventDate)

  if (repeatRule === "once") {
    const occurrence = `${year}-${pad(month)}-${pad(day)}`
    return dueAtFor(occurrence, leadDays) > after ? occurrence : null
  }

  /* Yearly. Starts from the year `after` falls in and steps forward; two iterations is the most it
     can ever take, since next year's send time is always in the future. The bound is a guard against
     a bug here becoming an infinite loop in a job that runs every minute. */
  const startYear = new Date(after).getUTCFullYear()
  for (let candidate = startYear; candidate <= startYear + 2; candidate++) {
    const occurrence = sameDayIn(candidate, month, day)
    if (dueAtFor(occurrence, leadDays) > after) return occurrence
  }
  return null
}

/**
 * Queue the next delivery for a reminder, if there is one and it is not already queued.
 *
 * Called on create, on edit, and by the drain after a successful send — the three moments when "what
 * happens next" can change. It is safe to call at any time and any number of times: the unique
 * constraint on (reminder, occurrence) makes a second call a no-op rather than a duplicate, which is
 * what lets the callers stay simple and not coordinate with each other.
 */
export async function queueNextDelivery(pool: Pool, reminderId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT event_date, repeat_rule, lead_days, is_active
       FROM crossfriend.reminders
      WHERE id = $1`,
    [reminderId]
  )

  const reminder = rows[0]
  if (!reminder || !reminder.is_active) return

  const eventDate = new Date(reminder.event_date).toISOString().slice(0, 10)
  const occurrence = nextOccurrence(
    eventDate,
    reminder.repeat_rule as RepeatRule,
    reminder.lead_days
  )
  if (!occurrence) return

  await pool.query(
    `INSERT INTO crossfriend.reminder_deliveries (reminder_id, occurrence_date, due_at, next_attempt_at)
     VALUES ($1, $2::date, $3, $3)
     ON CONFLICT (reminder_id, occurrence_date) DO NOTHING`,
    [reminderId, occurrence, dueAtFor(occurrence, reminder.lead_days)]
  )
}

/**
 * Drop queued deliveries that no longer match the reminder.
 *
 * Editing a date or a lead time has to move the pending occurrence, and the unique constraint means
 * it cannot simply be re-inserted. Only pending rows are touched: a delivery that already went out is
 * a record of something that happened to somebody, and rewriting history to match an edit would make
 * the delivery log useless for the one question it exists to answer.
 */
export async function clearPendingDeliveries(pool: Pool, reminderId: string): Promise<void> {
  await pool.query(
    `DELETE FROM crossfriend.reminder_deliveries
      WHERE reminder_id = $1 AND status = 'pending'`,
    [reminderId]
  )
}
