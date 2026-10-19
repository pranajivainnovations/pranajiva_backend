import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import { getBakerNetworkDbPool } from "../../../../services/baker-network/db"
import { sendSms } from "../../../../services/messaging/msg91"
import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"

/**
 * POST /ops/messaging/test-order-sms
 *
 * Sends one order template to a number of the operator's choosing, with obvious sample values, and
 * returns MSG91's unedited answer.
 *
 * ── Why this is needed and /ops/messaging/test-otp is not enough ───────────────────────────────
 * That route tests the login OTP, which goes through MSG91's SendOTP product where MSG91 owns the
 * code and injects it. The order templates go through the Flow API with variables we name
 * ourselves, and the failure modes are entirely different.
 *
 * The one that matters: MSG91 does not error on a variable-name mismatch. It substitutes an empty
 * string, delivers "Hi , your Pranajiva order  is confirmed", answers `{"type":"success"}` and
 * reports the message as sent on every dashboard it has. There is no way to detect that from the
 * provider, from our logs, or from the OPS screen — the only way to see it is to read the SMS. So
 * this endpoint exists to put that SMS on somebody's phone before a rule is switched on, rather
 * than after a customer has had the empty version.
 *
 * ── Why the sample values are what they are ────────────────────────────────────────────────────
 * `TEST`, `9999` and `1` rather than a plausible name, order number and amount. The point of
 * reading the test message is to see whether each blank was filled, and a value that could pass for
 * real defeats that: "Hi Ritu, your Pranajiva order 1090 for Rs 2399" reads correct whether or not
 * the variables matched, because a missing one is a space you do not notice. `Hi TEST, your
 * Pranajiva order 9999 ... Rs 1` cannot be misread either way.
 *
 * ── Why nothing is logged against an order ─────────────────────────────────────────────────────
 * There is no order. orders.notifications is the record of what a CUSTOMER was told, and writing a
 * test into it would put a message nobody received into the history the order page reads, against
 * an order id that would have to be invented. The log for this is the operator's own phone.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    return res.status(401).json({ error: "Unauthorized." })
  }

  const body = (req.body ?? {}) as { templateId?: string; mobile?: string }
  const templateId = String(body.templateId ?? "").trim()
  const mobile = String(body.mobile ?? "").replace(/\D/g, "").slice(-10)

  if (!/^[0-9a-f-]{36}$/i.test(templateId)) {
    return res.status(400).json({ error: "Pick a template to test." })
  }
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    return res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." })
  }

  /* Read through the template row rather than taking a provider id from the caller: this endpoint
     must only be able to send templates WE have registered, not any id somebody can type. */
  const { rows } = await getBakerNetworkDbPool().query(
    `SELECT label, sender_header, dlt_template_id, provider_template_id, is_active
       FROM crossfriend.sms_templates WHERE id = $1::uuid`,
    [templateId]
  )

  const template = rows[0]
  if (!template) return res.status(404).json({ error: "No such template." })

  if (!template.provider_template_id) {
    return res.status(400).json({
      error: `${template.label} has no MSG91 template ID, so there is nothing to send it through.`,
    })
  }

  /**
   * An inactive template can still be tested, deliberately.
   *
   * Inactive usually means "not proven yet" — which is exactly when somebody wants to send one test
   * message to themselves. Refusing here would mean the only way to try a template is to activate
   * it first, and activating an unproven template is the thing this endpoint exists to avoid.
   */
  const result = await sendSms({
    mobile,
    providerTemplateId: template.provider_template_id,
    variables: { name: "TEST", order_id: "9999", amount: "1" },
  })

  return res.status(200).json({
    ok: result.ok,
    error: result.ok ? null : result.error,
    providerMessageId: result.providerMessageId ?? null,
    sentConfig: {
      label: template.label,
      senderHeader: template.sender_header,
      dltTemplateId: template.dlt_template_id,
      providerTemplateId: template.provider_template_id,
      isActive: template.is_active === true,
      /* Echoed so the operator can compare what we sent against what the template registered —
         the mismatch this endpoint exists to catch is invisible everywhere else. */
      variables: { name: "TEST", order_id: "9999", amount: "1" },
    },
  })
}
