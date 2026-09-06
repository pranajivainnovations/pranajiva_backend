/**
 * MSG91 Flow API client.
 *
 * We send through MSG91's transactional Flow endpoint rather than their hosted OTP widget. The
 * widget would generate, store and verify the code on MSG91's side, which is less code — but the
 * OTP would then live in a vendor session we cannot inspect, rate-limit on our own terms, or carry
 * with us to another provider. Owning the code in our Redis costs one file and keeps the flow
 * provider-shaped rather than MSG91-shaped.
 *
 * ── The auth key is an environment variable, deliberately ──────────────────────────────────────
 * MSG91_AUTH_KEY can send SMS and spend money, so it is a credential and not a setting. It sits
 * with DATABASE_URL and the AI provider keys, where OPS cannot read it back out. Everything an
 * operator would actually want to change — header, template, timings — is in the database instead.
 */

const MSG91_FLOW_URL = "https://control.msg91.com/api/v5/flow/"

/** How long we wait on MSG91 before giving up. A customer is watching a spinner behind this. */
const TIMEOUT_MS = 8000

export interface SendSmsParams {
  /** Bare 10-digit Indian mobile. Country code is added here so callers cannot double-prefix it. */
  mobile: string
  providerTemplateId: string
  /** Flow variables by name, matching the placeholders registered in the DLT template. */
  variables: Record<string, string>
}

/**
 * Flat rather than a discriminated union, for the same reason as IssueResult in ./otp — this
 * project compiles without `strict`, and TypeScript will not narrow a union by a boolean
 * discriminant when strictNullChecks is off.
 */
export interface SendSmsResult {
  ok: boolean
  providerMessageId?: string | null
  error?: string
}

export function isProviderConfigured(): boolean {
  return Boolean(process.env.MSG91_AUTH_KEY)
}

export async function sendSms({
  mobile,
  providerTemplateId,
  variables,
}: SendSmsParams): Promise<SendSmsResult> {
  const authKey = process.env.MSG91_AUTH_KEY
  if (!authKey) {
    // Not a thrown error: the caller turns this into a "try again later" for the customer while
    // logging loudly. A missing key is an operator problem, and telling the customer that the SMS
    // provider is unconfigured tells an attacker something too.
    return { ok: false, error: "MSG91_AUTH_KEY is not set" }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(MSG91_FLOW_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authkey: authKey,
      },
      body: JSON.stringify({
        template_id: providerTemplateId,
        // MSG91 expects the country code inline with no plus sign.
        recipients: [{ mobiles: `91${mobile}`, ...variables }],
      }),
      signal: controller.signal,
    })

    const text = await res.text()

    if (!res.ok) {
      return { ok: false, error: `MSG91 HTTP ${res.status}: ${text.slice(0, 300)}` }
    }

    /**
     * MSG91 answers 200 for business failures too — an unapproved template or a header that does
     * not match the template returns `{"type":"error", ...}` with a 200 status. Treating HTTP 200
     * as success is the classic way to ship a login that silently sends nothing, so the body is
     * what decides here.
     */
    let payload: { type?: string; message?: unknown } = {}
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, error: `MSG91 returned unparseable body: ${text.slice(0, 300)}` }
    }

    if (payload.type !== "success") {
      const message =
        typeof payload.message === "string" ? payload.message : JSON.stringify(payload.message)
      return { ok: false, error: `MSG91 rejected the send: ${message?.slice(0, 300)}` }
    }

    return {
      ok: true,
      providerMessageId: typeof payload.message === "string" ? payload.message : null,
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timed out" : String(err)
    return { ok: false, error: `MSG91 request failed: ${reason}` }
  } finally {
    clearTimeout(timer)
  }
}
