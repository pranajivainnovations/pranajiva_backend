/**
 * POST /store/crossfriend/otp/verify — the original path, kept as an alias.
 *
 * Same handler as /store/otp/verify, for the deployed CrossFriend storefront. See the note in the
 * sibling send/route.ts for why the alias re-exports rather than redirects, and when it can go.
 */
export { handleOtpVerify as POST } from "../../../../../services/messaging/otp-endpoints"
