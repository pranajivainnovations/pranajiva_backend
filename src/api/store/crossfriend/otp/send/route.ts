/**
 * POST /store/crossfriend/otp/send — the original path, kept as an alias.
 *
 * ── Why this still exists ──────────────────────────────────────────────────────────────────────
 * Three callers are pointed at it and two of them are already deployed: the CrossFriend storefront's
 * send and verify proxies, and the OPS setup checklist, which probes this exact URL and reads a 400
 * as "the route is live" against a 404 as "not deployed". Removing it in the same change that adds
 * the brand-neutral path would take the storefront's sign-in down and blank a signal in OPS, to save
 * two files.
 *
 * It re-exports the handler rather than forwarding to the new URL. A 307 would work for the two
 * server-side callers but would double every sign-in request's latency for no benefit, and the
 * behaviour has to stay identical — two mounts of one function is the only arrangement where it
 * cannot drift.
 *
 * Retire it once the storefront and the OPS checklist both call /store/otp/*, not before.
 */
export { handleOtpSend as POST } from "../../../../../services/messaging/otp-endpoints"
