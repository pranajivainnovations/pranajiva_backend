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

/**
 * ── Brands, and the login flow each one signs in through ───────────────────────────────────────
 *
 * The storefronts think in brands; this table is the only place that knows a brand's login SMS is
 * carried by a particular flow row. That indirection earns its keep immediately, because the two
 * flow keys are not symmetrical: CrossFriend's predates the second brand and is named after the
 * feature that first needed it (`ai_studio_login`) rather than after the brand. Renaming it would
 * orphan every `otp_attempts` row keyed by it and break the deployed storefront mid-flight, for no
 * gain — so the asymmetry is contained here instead, where it is one line and visible.
 *
 * Adding a brand is this table plus a seeded `message_flows` row. Adding a *second flow* for an
 * existing brand — an order-confirmation OTP, say — is deliberately not expressible here: this maps
 * brand to its LOGIN flow, and a route that serves other flows should say so in its own name.
 */
export const LOGIN_FLOW_BY_BRAND = {
  crossfriend: "ai_studio_login",
  pranajiva: "pranajiva_login",
} as const

export type Brand = keyof typeof LOGIN_FLOW_BY_BRAND

/**
 * What a caller that names neither a brand nor a flow gets.
 *
 * CrossFriend, because the deployed storefront has always omitted the brand and must keep working
 * unchanged. A new caller should always be explicit; this default exists for the old one.
 */
export const DEFAULT_BRAND: Brand = "crossfriend"

const KNOWN_FLOWS: ReadonlySet<string> = new Set(Object.values(LOGIN_FLOW_BY_BRAND))

export function isBrand(value: unknown): value is Brand {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LOGIN_FLOW_BY_BRAND, value)
}

/**
 * Resolve the flow a sign-in request is for, from either parameter.
 *
 * `brand` is what new callers send. `flow` is what the deployed CrossFriend storefront sends and
 * keeps sending. Both are accepted, and both are checked against a closed set — a caller must never
 * be able to name an arbitrary flow and drive an unrelated template's SMS.
 *
 * Sending BOTH and disagreeing is refused rather than resolved by precedence. Quietly preferring one
 * would mean a caller that believes it is signing someone in to PranaJiva sends them a CrossFriend
 * OTP, from the CrossFriend header — a wrong-brand message that looks like a successful send from
 * every angle except the customer's.
 *
 * Returns a flat result rather than throwing: every caller is an HTTP handler that must answer 400
 * with a customer-safe string, and `error` here is already that string.
 */
export function resolveLoginFlow(input: {
  brand?: unknown
  flow?: unknown
}): { flowKey: string; brand: Brand } | { error: string } {
  const brandGiven = input.brand !== undefined && input.brand !== null && input.brand !== ""
  const flowGiven = input.flow !== undefined && input.flow !== null && input.flow !== ""

  if (brandGiven && !isBrand(input.brand)) return { error: "Unknown sign-in flow." }
  if (flowGiven && !KNOWN_FLOWS.has(String(input.flow))) return { error: "Unknown sign-in flow." }

  if (brandGiven && flowGiven && LOGIN_FLOW_BY_BRAND[input.brand as Brand] !== String(input.flow)) {
    return { error: "Unknown sign-in flow." }
  }

  const brand: Brand = brandGiven
    ? (input.brand as Brand)
    : flowGiven
      ? (Object.keys(LOGIN_FLOW_BY_BRAND) as Brand[]).find(
          (b) => LOGIN_FLOW_BY_BRAND[b] === String(input.flow)
        )!
      : DEFAULT_BRAND

  return { flowKey: LOGIN_FLOW_BY_BRAND[brand], brand }
}
