import { getOrdersDbPool } from "./db"
import { isProviderConfigured, sendSms } from "../messaging/msg91"

/**
 * Telling a customer their order moved.
 *
 * ── Why nothing here can break an order ────────────────────────────────────────────────────────
 * Every function returns a reason instead of throwing, and the caller does not await a result it
 * acts on. An SMS is a courtesy; the order is the fact. A provider outage, a missing template or an
 * unapproved sender must never be the reason an ops user cannot mark a cake delivered — and the
 * customer's own order page carries the same information regardless, which is why the page was
 * built to show status and payment separately in the first place.
 *
 * ── Why it is dormant until somebody fills in a template ───────────────────────────────────────
 * Every transactional SMS in India needs a DLT-registered template, approved per sender header,
 * and the approvals arrive weeks apart one at a time. So the rule table ships seeded and switched
 * off: this code runs on every status change from the day it deploys and sends nothing until a
 * template id is entered in OPS. There is no second deploy waiting on an approval.
 *
 * ── Why a send is recorded before it is attempted ──────────────────────────────────────────────
 * It is not. The row is written after, with the outcome — but the unique index is on successes
 * only, so two simultaneous attempts can both try and only one can record a success. Reserving
 * first would mean a crash between reserving and sending left a customer silently un-notified with
 * the slot used up, which is the worse failure of the two.
 */

export interface NotifyOutcome {
  sent: boolean
  reason:
    | "sent"
    | "already_sent"
    | "no_rule"
    | "disabled"
    | "no_template"
    | "no_mobile"
    | "provider_unconfigured"
    | "provider_refused"
    | "error"
  detail?: string
}

/** Ten digits, however the number was stored — +91, 91, spaces and all. */
function tenDigits(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, "")
  const ten = digits.length > 10 ? digits.slice(-10) : digits
  return /^[6-9]\d{9}$/.test(ten) ? ten : null
}

/**
 * Announce one status change.
 *
 * `status` is the order status, plus the pseudo-status `paid`, which is not an order status at all
 * — payment moves on its own track — but is the single thing customers most want confirmed, so it
 * gets a rule of its own rather than being folded into `placed`.
 */
export async function notifyOrderStatus(input: {
  orderId: string
  status: string
}): Promise<NotifyOutcome> {
  const db = getOrdersDbPool()

  try {
    const { rows } = await db.query(
      `SELECT o.id, o.display_id, o.brand, o.payable_paise, o.address,
              c.phone AS customer_phone,
              r.is_enabled, r.template_id,
              t.provider_template_id, t.label AS template_label,
              EXISTS (
                SELECT 1 FROM orders.notifications n
                 WHERE n.order_id = o.id AND n.status = $2 AND n.sent_ok
              ) AS already
         FROM orders.orders o
         LEFT JOIN public.customer c ON c.id = o.customer_id
         LEFT JOIN orders.notify_rules r ON r.brand = o.brand AND r.status = $2
         LEFT JOIN crossfriend.sms_templates t ON t.id = r.template_id AND t.is_active
        WHERE o.id = $1::uuid`,
      [input.orderId, input.status]
    )

    if (!rows.length) return { sent: false, reason: "error", detail: "no such order" }
    const row = rows[0]

    if (row.already) return { sent: false, reason: "already_sent" }
    if (row.is_enabled === null) return { sent: false, reason: "no_rule" }
    if (!row.is_enabled) return { sent: false, reason: "disabled" }
    if (!row.provider_template_id) return { sent: false, reason: "no_template" }

    /* The order's own address phone is the one the customer gave for THIS delivery, so it beats the
       account number — they are usually the same and, when they are not, the delivery one is right. */
    const mobile = tenDigits(row.address?.phone) ?? tenDigits(row.customer_phone)
    if (!mobile) return { sent: false, reason: "no_mobile" }

    if (!isProviderConfigured()) return { sent: false, reason: "provider_unconfigured" }

    /**
     * The variables every order template may use.
     *
     * Deliberately the same set for all of them: a DLT template picks the ones it registered and
     * MSG91 ignores the rest, so a new approved template needs no code change here. Values are
     * strings because that is what the flow endpoint takes.
     */
    const result = await sendSms({
      mobile,
      providerTemplateId: row.provider_template_id,
      variables: {
        ORDER: String(row.display_id),
        NAME: String(row.address?.first_name ?? "there"),
        AMOUNT: String(Math.round(Number(row.payable_paise) / 100)),
      },
    })

    await db.query(
      `INSERT INTO orders.notifications
         (order_id, status, mobile, template_id, sent_ok, provider_message_id, error)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        input.orderId,
        input.status,
        mobile,
        row.template_id,
        result.ok,
        result.providerMessageId ?? null,
        result.ok ? null : (result.error ?? "").slice(0, 500),
      ]
    )

    if (!result.ok) {
      console.error(`[orders/notify] ${input.status} on ${row.display_id} refused: ${result.error}`)
      return { sent: false, reason: "provider_refused", detail: result.error }
    }

    return { sent: true, reason: "sent" }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[orders/notify] ${input.status} on ${input.orderId} failed: ${detail}`)
    return { sent: false, reason: "error", detail }
  }
}

/**
 * Fire and forget, for callers whose own job must not wait on a text message.
 *
 * The 8-second MSG91 timeout would otherwise sit inside an ops user's button press, and a webhook's
 * response to Razorpay. Neither should be slowed by a courtesy, and neither has anything useful to
 * do with the result — the log and the OPS screen are where a failure is read.
 */
export function notifyOrderStatusDetached(input: { orderId: string; status: string }): void {
  void notifyOrderStatus(input).catch(() => {
    /* notifyOrderStatus already logs; this only stops an unhandled rejection. */
  })
}
