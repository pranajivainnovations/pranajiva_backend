import type { Pool } from "pg"
import webpush from "web-push"

import { dueAtFor, nextOccurrence, queueNextDelivery, type RepeatRule } from "./schedule"

/**
 * Sending the reminders that are due.
 *
 * ── Why a claim step before sending ────────────────────────────────────────────────────────────
 * The drain runs on a schedule, and a scheduled job can overlap itself — a slow run still working
 * when the next one starts is normal, not exceptional. Two runs selecting the same due rows would
 * send the same reminder twice, which for this product is worse than not sending it: a duplicate is
 * visible, looks broken, and is the kind of thing people screenshot.
 *
 * So rows are claimed with `FOR UPDATE SKIP LOCKED` and their attempt recorded in the same
 * statement. A second run sees nothing to do rather than the same work, and no coordination between
 * runs is needed. The unique constraint on (reminder, occurrence) is the backstop underneath it.
 *
 * ── Why failure retries rather than gives up ───────────────────────────────────────────────────
 * Push services have bad minutes. Giving up on the first non-fatal error would mean a birthday
 * reminder lost to a thirty-second outage, and nobody reports a notification they never received —
 * they just stop trusting the product. Transient failures back off and try again; only the two
 * statuses that mean "this subscription no longer exists" are treated as final.
 */

const MAX_ATTEMPTS = 5

/** Exponential, in minutes: 2, 8, 32, 128. Roughly three hours of trying before giving up. */
function backoffMinutes(attempt: number): number {
  return 2 * Math.pow(4, attempt - 1)
}

/** How many due reminders one run will handle. Bounded so a backlog cannot become one enormous run. */
const BATCH = 200

export interface DrainResult {
  claimed: number
  sent: number
  retried: number
  failed: number
}

function vapid(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  if (!publicKey || !privateKey) return null
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT?.trim() || "mailto:ops@crossfriend.in",
  }
}

/**
 * One pass over everything that is due.
 *
 * Returns counts rather than logging them, so the caller decides what is worth saying — and so this
 * can be called from a test or a one-off script without writing to the job log.
 */
export async function drainDueReminders(pool: Pool): Promise<DrainResult> {
  const config = vapid()
  if (!config) return { claimed: 0, sent: 0, retried: 0, failed: 0 }

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey)

  /**
   * Claim and record the attempt atomically.
   *
   * The UPDATE is what makes this safe against an overlapping run: whichever transaction gets the
   * row locks it, bumps the attempt, and pushes next_attempt_at out of the way. Anything else
   * skips it. The row stays 'pending' until we know how the send went.
   */
  const { rows: claimed } = await pool.query(
    `UPDATE crossfriend.reminder_deliveries d
        SET attempts = d.attempts + 1,
            /* Held off for a few minutes while this run works on it, so a crash mid-send leaves the
               row retryable rather than stuck or immediately re-picked by the next run. */
            next_attempt_at = NOW() + INTERVAL '5 minutes'
       FROM (
         SELECT id FROM crossfriend.reminder_deliveries
          WHERE status = 'pending' AND next_attempt_at <= NOW()
          ORDER BY due_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ) AS due
      WHERE d.id = due.id
      RETURNING d.id, d.reminder_id, d.occurrence_date, d.attempts`,
    [BATCH]
  )

  if (claimed.length === 0) return { claimed: 0, sent: 0, retried: 0, failed: 0 }

  const result: DrainResult = { claimed: claimed.length, sent: 0, retried: 0, failed: 0 }

  for (const delivery of claimed) {
    try {
      const outcome = await deliverOne(pool, delivery)
      if (outcome === "sent") result.sent += 1
      else if (outcome === "retry") result.retried += 1
      else result.failed += 1
    } catch (error) {
      // A bug in one reminder must not stop the other 199.
      console.error("[reminders] delivery threw", delivery.id, error)
      await markRetryOrFail(pool, delivery.id, delivery.attempts, String(error))
      result.retried += 1
    }
  }

  return result
}

async function deliverOne(
  pool: Pool,
  delivery: { id: string; reminder_id: string; occurrence_date: Date; attempts: number }
): Promise<"sent" | "retry" | "failed"> {
  const { rows } = await pool.query(
    `SELECT r.id, r.customer_id, r.title, r.event_date, r.repeat_rule, r.lead_days, r.is_active
       FROM crossfriend.reminders r
      WHERE r.id = $1`,
    [delivery.reminder_id]
  )
  const reminder = rows[0]

  /* Paused or deleted between queueing and sending. Cancelled rather than failed — nothing went
     wrong, the person changed their mind, and the log should say so. */
  if (!reminder || !reminder.is_active) {
    await pool.query(
      `UPDATE crossfriend.reminder_deliveries SET status = 'cancelled' WHERE id = $1`,
      [delivery.id]
    )
    return "failed"
  }

  const { rows: devices } = await pool.query(
    `SELECT id, endpoint, p256dh, auth
       FROM crossfriend.push_subscribers
      WHERE customer_id = $1 AND failed_at IS NULL AND revoked_at IS NULL`,
    [reminder.customer_id]
  )

  const occurrence = new Date(delivery.occurrence_date).toISOString().slice(0, 10)

  /**
   * Nowhere to send it, and that is not a failure.
   *
   * The person may have never enabled notifications, or be on an iPhone where the browser does not
   * offer them. The reminder still exists and still shows on their Coming up list, which is the
   * floor this product deliberately stands on — a reminder must never be *only* a notification that
   * might not arrive. Marked sent so it does not retry forever against a device that will never be
   * there, with the reason recorded so the log stays honest about what happened.
   */
  if (devices.length === 0) {
    await pool.query(
      `UPDATE crossfriend.reminder_deliveries
          SET status = 'sent', sent_at = NOW(), last_error = 'no subscribed device'
        WHERE id = $1`,
      [delivery.id]
    )
    await scheduleFollowing(pool, reminder, occurrence)
    return "sent"
  }

  const payload = JSON.stringify({
    title: reminder.title,
    body: describeWhen(occurrence, reminder.lead_days),
    url: "/assistant",
    /* Tagged per occurrence, so this year's birthday reminder replaces a stale one rather than
       stacking, but next year's is its own notification. */
    tag: `cf-reminder-${delivery.reminder_id.slice(0, 8)}-${occurrence}`,
  })

  const results = await Promise.allSettled(
    devices.map((device) =>
      webpush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        payload,
        /* A day. A reminder that surfaces two days late is worse than one that never arrives — the
           person has already missed the thing it was about. */
        { TTL: 60 * 60 * 24 }
      )
    )
  )

  const dead: string[] = []
  let anyDelivered = false

  results.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      anyDelivered = true
      return
    }
    const status = (outcome.reason as { statusCode?: number })?.statusCode
    if (status === 404 || status === 410) dead.push(devices[index].id)
  })

  if (dead.length > 0) {
    await pool.query(
      `UPDATE crossfriend.push_subscribers
          SET failed_at = NOW(), failure_count = failure_count + 1
        WHERE id = ANY($1::uuid[])`,
      [dead]
    )
  }

  /* One device is enough. Somebody with a dead laptop subscription and a working phone has been
     reminded, and retrying because the laptop failed would notify the phone again. */
  if (anyDelivered) {
    await pool.query(
      `UPDATE crossfriend.reminder_deliveries
          SET status = 'sent', sent_at = NOW(), last_error = NULL
        WHERE id = $1`,
      [delivery.id]
    )
    await scheduleFollowing(pool, reminder, occurrence)
    return "sent"
  }

  /* Every device was already gone — retrying will not conjure one. Treated as delivered-nowhere for
     the same reason as the no-devices case above, rather than burning five attempts. */
  if (dead.length === devices.length) {
    await pool.query(
      `UPDATE crossfriend.reminder_deliveries
          SET status = 'sent', sent_at = NOW(), last_error = 'all devices gone'
        WHERE id = $1`,
      [delivery.id]
    )
    await scheduleFollowing(pool, reminder, occurrence)
    return "sent"
  }

  await markRetryOrFail(pool, delivery.id, delivery.attempts, "push service did not accept")
  return delivery.attempts >= MAX_ATTEMPTS ? "failed" : "retry"
}

async function markRetryOrFail(
  pool: Pool,
  deliveryId: string,
  attempts: number,
  error: string
): Promise<void> {
  if (attempts >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE crossfriend.reminder_deliveries
          SET status = 'failed', last_error = $2
        WHERE id = $1`,
      [deliveryId, error.slice(0, 500)]
    )
    return
  }

  await pool.query(
    `UPDATE crossfriend.reminder_deliveries
        SET next_attempt_at = NOW() + ($2 || ' minutes')::interval, last_error = $3
      WHERE id = $1`,
    [deliveryId, String(backoffMinutes(attempts)), error.slice(0, 500)]
  )
}

/**
 * Queue next year's, once this year's has gone.
 *
 * Done here rather than in a nightly sweep so the chain cannot break: the moment a delivery
 * succeeds, the following one exists. A separate job that walked every reminder would be a second
 * thing that has to keep working, and its failure would be silent until a year of birthdays had
 * already been missed.
 */
async function scheduleFollowing(
  pool: Pool,
  reminder: { id: string; event_date: Date; repeat_rule: string; lead_days: number },
  justSent: string
): Promise<void> {
  if (reminder.repeat_rule !== "yearly") return

  const eventDate = new Date(reminder.event_date).toISOString().slice(0, 10)
  /* Computed from just after this occurrence's send time, not from now — otherwise a delivery that
     was retried into the following day would skip a year. */
  const after = dueAtFor(justSent, reminder.lead_days)
  const following = nextOccurrence(
    eventDate,
    reminder.repeat_rule as RepeatRule,
    reminder.lead_days,
    new Date(after.getTime() + 1000)
  )
  if (!following) return

  await pool.query(
    `INSERT INTO crossfriend.reminder_deliveries (reminder_id, occurrence_date, due_at, next_attempt_at)
     VALUES ($1, $2::date, $3, $3)
     ON CONFLICT (reminder_id, occurrence_date) DO NOTHING`,
    [reminder.id, following, dueAtFor(following, reminder.lead_days)]
  )
}

/** "Today", "Tomorrow", "In 3 days" — the reason the notification is arriving now. */
function describeWhen(occurrence: string, leadDays: number): string {
  if (leadDays === 0) return "That's today."
  if (leadDays === 1) return "That's tomorrow."
  return `That's in ${leadDays} days — ${new Date(`${occurrence}T00:00:00+05:30`).toLocaleDateString(
    "en-IN",
    { timeZone: "Asia/Kolkata", day: "numeric", month: "long" }
  )}.`
}

export { queueNextDelivery }
