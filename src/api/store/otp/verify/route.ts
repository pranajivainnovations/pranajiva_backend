/**
 * POST /store/otp/verify — submit a sign-in code and receive a customer token.
 *
 * The canonical path, paired with /store/otp/send. Body: `{ mobile, otp, brand? }`.
 *
 * The brand selects which flow's attempt caps and code length apply; it never reaches the customer
 * lookup, because one mobile must resolve to one customer row whichever storefront it arrives from.
 */
export { handleOtpVerify as POST } from "../../../../services/messaging/otp-endpoints"
