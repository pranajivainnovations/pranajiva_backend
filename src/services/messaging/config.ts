/**
 * Reads the OPS-managed messaging configuration: which template a flow sends through, under which
 * DLT header, and the OTP policy for that flow.
 *
 * Everything here is editable in OPS without a deploy — that is the whole point of the tables. The
 * one thing that is NOT here is the provider auth key, which stays in the environment; see the
 * migration for why that line is drawn where it is.
 */

import { getBakerNetworkDbPool } from "../baker-network/db"

export interface FlowConfig {
  flowKey: string
  label: string
  otpLength: number
  otpTtlSeconds: number
  maxAttempts: number
  resendCooldownSeconds: number
  dailySendLimit: number
  isEnabled: boolean
  /** Null when OPS has not assigned a template yet — the send path treats this as not configured. */
  template: {
    id: string
    label: string
    senderHeader: string
    dltTemplateId: string
    providerTemplateId: string
    isActive: boolean
  } | null
}

/**
 * A flow is only sendable when OPS has switched it on AND pointed it at an active template.
 *
 * Three separate conditions rather than one flag because they fail for different reasons and the
 * operator needs to know which: the flow is off, no template is assigned, or the assigned template
 * has been deactivated (typically because DLT rejected it). Collapsing them into "not configured"
 * would make a rejected template look identical to an unfinished setup.
 */
export function flowBlockedReason(config: FlowConfig | null): string | null {
  if (!config) return "This sign-in flow is not configured."
  if (!config.isEnabled) return "This sign-in flow is currently switched off."
  if (!config.template) return "No SMS template is assigned to this flow."
  if (!config.template.isActive) return "The SMS template assigned to this flow is inactive."
  if (!config.template.providerTemplateId) {
    return "The SMS template assigned to this flow has no provider template ID."
  }
  return null
}

export async function getFlowConfig(flowKey: string): Promise<FlowConfig | null> {
  const pool = getBakerNetworkDbPool()

  const result = await pool.query(
    `SELECT f.flow_key,
            f.label,
            f.otp_length,
            f.otp_ttl_seconds,
            f.max_attempts,
            f.resend_cooldown_seconds,
            f.daily_send_limit,
            f.is_enabled,
            t.id                   AS template_id,
            t.label                AS template_label,
            t.sender_header,
            t.dlt_template_id,
            t.provider_template_id,
            t.is_active            AS template_is_active
       FROM crossfriend.message_flows f
       LEFT JOIN crossfriend.sms_templates t ON t.id = f.template_id
      WHERE f.flow_key = $1`,
    [flowKey]
  )

  const row = result.rows[0]
  if (!row) return null

  return {
    flowKey: row.flow_key,
    label: row.label,
    otpLength: Number(row.otp_length),
    otpTtlSeconds: Number(row.otp_ttl_seconds),
    maxAttempts: Number(row.max_attempts),
    resendCooldownSeconds: Number(row.resend_cooldown_seconds),
    dailySendLimit: Number(row.daily_send_limit),
    isEnabled: row.is_enabled === true,
    template: row.template_id
      ? {
          id: row.template_id,
          label: row.template_label,
          senderHeader: row.sender_header,
          dltTemplateId: row.dlt_template_id,
          providerTemplateId: row.provider_template_id ?? "",
          isActive: row.template_is_active === true,
        }
      : null,
  }
}
