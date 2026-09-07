/**
 * MSG91 SendOTP V5 client.
 *
 * MSG91 generates, stores, expires and verifies the code. We never see it. This replaces the Flow
 * API client in ./msg91.ts, which used MSG91 purely as an SMS transport while we owned the code —
 * that file is retained as a rollback path and is still reachable by setting MSG91_OTP_MODE=legacy.
 *
 * ── Why the template ID choice matters here ────────────────────────────────────────────────────
 * Template 6a9ed4d8084a0d13c50ebe52 is registered on MSG91 as an OTP template, not a Flow template.
 * Sending it through the Flow endpoint was the original defect: Flow expects us to supply the
 * variable, so the placeholder name had to match ours exactly, and a mismatch would have delivered
 * "is your Pranajiva OTP." with the digits missing and no error anywhere. Under SendOTP, MSG91
 * substitutes ##OTP## itself with the code it generated, so that entire class of failure is gone.
 *
 * ── Fail-closed, without depending on message strings ──────────────────────────────────────────
 * MSG91's response bodies are documented only loosely, and the exact `message` text for each error
 * could not be confirmed against their published documentation. So correctness here rests on one
 * rule that does not need those strings: `type === "success"` is the only thing that ever produces
 * a success, and every other outcome — non-2xx, unparseable body, missing field, timeout, unknown
 * `type` — is a failure. The message text is read afterwards, and only to choose a friendlier
 * sentence for the customer. Getting the classification wrong shows a vaguer error; it can never
 * admit anyone.
 */

const OTP_BASE = "https://control.msg91.com/api/v5/otp"

/** A customer is watching a spinner behind every one of these calls. */
const TIMEOUT_MS = 8000

export type OtpFailureKind =
  | "wrong"
  | "expired"
  | "already_verified"
  | "provider_limit"
  | "unavailable"
  | "unknown"

/**
 * MSG91's answer, untouched, for the OPS diagnostics panel.
 *
 * The customer-facing routes deliberately replace this with a generic sentence — "temporarily
 * unavailable" gives an attacker nothing, and gives a customer nothing they can act on either. But
 * that same discretion makes a misconfigured template almost undiagnosable from the outside, which
 * is why exactly one caller (the service-key-protected /ops route) is allowed to read this through.
 *
 * `url` has the auth key stripped, because it is passed as a header — but the redaction in
 * describeUrl() is belt-and-braces against anyone later moving it into the query string, which is
 * the other form MSG91 accepts.
 */
export interface Msg91Raw {
  httpStatus: number | null
  type: string | null
  message: string | null
  url: string
}

export interface Msg91Result {
  ok: boolean
  /** Present on success — MSG91's request id, useful when raising a support ticket. */
  requestId?: string | null
  /** Operator-facing detail. Never returned to the browser verbatim. */
  error?: string
  /** Set on failure so the route can choose a customer-facing sentence. */
  kind?: OtpFailureKind
  /** Diagnostics. Only ever surfaced by the OPS test endpoint. */
  raw?: Msg91Raw
}

/** Strips anything that looks like a credential before a URL is shown to an operator. */
function describeUrl(url: string): string {
  return url.replace(/([?&](authkey|authKey)=)[^&]*/gi, "$1<redacted>")
}

export function isProviderConfigured(): boolean {
  return Boolean(process.env.MSG91_AUTH_KEY)
}

/** MSG91 wants the country code inline with no plus sign. Centralised so no caller double-prefixes. */
function withCountryCode(mobile: string): string {
  return `91${mobile}`
}

/**
 * Classifies a rejection from the text MSG91 returned.
 *
 * Substring matching on lowercased text rather than equality: the exact wording is not contractual
 * and has changed between MSG91 revisions, so an exact-match table would silently degrade to
 * "unknown" after an upstream copy edit. Every branch here is a failure regardless — this only
 * decides which sentence the customer reads.
 */
function classify(message: string): OtpFailureKind {
  const m = message.toLowerCase()
  if (m.includes("already") && m.includes("verif")) return "already_verified"
  if (m.includes("expire")) return "expired"
  if (m.includes("not match") || m.includes("mismatch") || m.includes("invalid otp")) return "wrong"
  if (m.includes("limit") || m.includes("attempt") || m.includes("exceed")) return "provider_limit"
  return "unknown"
}

/**
 * One place where every MSG91 response is turned into a verdict.
 *
 * Deliberately takes the Response and does its own body reading, so no caller can accidentally
 * treat `res.ok` as the answer. MSG91 returns HTTP 200 for business failures — an unapproved
 * template, a wrong code — with `{"type":"error"}` in the body, so status alone is meaningless.
 */
async function interpret(res: Response, url: string, context: string): Promise<Msg91Result> {
  const text = await res.text().catch(() => "")
  const base: Msg91Raw = {
    httpStatus: res.status,
    type: null,
    message: text.slice(0, 500) || null,
    url: describeUrl(url),
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `${context}: HTTP ${res.status} ${text.slice(0, 300)}`,
      kind: "unavailable",
      raw: base,
    }
  }

  let payload: { type?: unknown; message?: unknown }
  try {
    payload = JSON.parse(text)
  } catch {
    return {
      ok: false,
      error: `${context}: unparseable body ${text.slice(0, 300)}`,
      kind: "unavailable",
      raw: base,
    }
  }

  const message =
    typeof payload.message === "string" ? payload.message : JSON.stringify(payload.message ?? "")
  const raw: Msg91Raw = {
    ...base,
    type: payload.type == null ? null : String(payload.type),
    message: message.slice(0, 500) || null,
  }

  // The single success condition in this file.
  if (payload.type === "success") {
    return {
      ok: true,
      requestId: typeof payload.message === "string" ? payload.message : null,
      raw,
    }
  }

  return {
    ok: false,
    error: `${context}: ${String(payload.type ?? "no type")} — ${message.slice(0, 300)}`,
    kind: classify(message),
    raw,
  }
}

/** Wraps fetch so a timeout or a DNS failure becomes a failed Msg91Result, never a thrown error. */
async function call(url: string, method: "GET" | "POST", context: string): Promise<Msg91Result> {
  const authKey = process.env.MSG91_AUTH_KEY
  if (!authKey) {
    return {
      ok: false,
      error: `${context}: MSG91_AUTH_KEY is not set`,
      kind: "unavailable",
      raw: { httpStatus: null, type: null, message: "MSG91_AUTH_KEY is not set", url: describeUrl(url) },
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method,
      headers: { authkey: authKey, Accept: "application/json" },
      signal: controller.signal,
    })
    return await interpret(res, url, context)
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timed out" : String(err)
    return {
      ok: false,
      error: `${context}: request failed — ${reason}`,
      kind: "unavailable",
      raw: { httpStatus: null, type: null, message: reason, url: describeUrl(url) },
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface SendOtpParams {
  mobile: string
  /** MSG91 OTP template id — e.g. 6a9ed4d8084a0d13c50ebe52. Not the DLT id. */
  templateId: string
  otpLength: number
  /**
   * MINUTES. Our configuration and database both store seconds, so the conversion happens at the
   * call site and is asserted here — passing 600 where MSG91 expects minutes would issue a code
   * valid for ten hours, which no test would notice and which silently widens the attack window.
   */
  otpExpiryMinutes: number
}

export async function sendOtp({
  mobile,
  templateId,
  otpLength,
  otpExpiryMinutes,
}: SendOtpParams): Promise<Msg91Result> {
  if (!Number.isInteger(otpExpiryMinutes) || otpExpiryMinutes < 1 || otpExpiryMinutes > 1440) {
    return {
      ok: false,
      error: `sendOtp: otp_expiry must be 1–1440 minutes, got ${otpExpiryMinutes}`,
      kind: "unavailable",
      raw: {
        httpStatus: null,
        type: null,
        message: `Refused before sending: otp_expiry ${otpExpiryMinutes} is outside 1-1440 minutes`,
        url: "(not called)",
      },
    }
  }

  const params = new URLSearchParams({
    template_id: templateId,
    mobile: withCountryCode(mobile),
    otp_length: String(otpLength),
    otp_expiry: String(otpExpiryMinutes),
    // Ask MSG91 to report delivery problems synchronously instead of accepting and failing later,
    // so a rejected template surfaces on this request rather than as a customer who never gets a code.
    realTimeResponse: "1",
  })

  return call(`${OTP_BASE}?${params.toString()}`, "POST", "sendOtp")
}

export async function verifyOtp(mobile: string, otp: string): Promise<Msg91Result> {
  const params = new URLSearchParams({ mobile: withCountryCode(mobile), otp })
  return call(`${OTP_BASE}/verify?${params.toString()}`, "GET", "verifyOtp")
}

/**
 * Resends the SAME code MSG91 already issued.
 *
 * retrytype=text because MSG91 defaults this to voice, which would place a phone call to a customer
 * who pressed "Resend OTP" on a web form.
 */
export async function retryOtp(mobile: string): Promise<Msg91Result> {
  const params = new URLSearchParams({ mobile: withCountryCode(mobile), retrytype: "text" })
  return call(`${OTP_BASE}/retry?${params.toString()}`, "GET", "retryOtp")
}
