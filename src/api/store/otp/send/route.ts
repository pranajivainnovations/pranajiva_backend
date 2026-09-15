/**
 * POST /store/otp/send — request a sign-in code, for either brand.
 *
 * The canonical path. `/store/crossfriend/otp/send` mounts the same handler and stays for the
 * deployed CrossFriend storefront; new callers name their brand and come here.
 *
 * Body: `{ mobile, brand?: "crossfriend" | "pranajiva" }`. Omitting `brand` means CrossFriend, which
 * is what the older callers relied on. `flow` is still accepted for them; see resolveLoginFlow.
 */
export { handleOtpSend as POST } from "../../../../services/messaging/otp-endpoints"
