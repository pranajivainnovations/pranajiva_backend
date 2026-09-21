import { getWalletDbPool } from "../wallet/db"

/**
 * Finding a customer the way the ops team actually knows them — by mobile number.
 *
 * Nobody in support has a customer id to hand. They have a phone number, because that is what the
 * person on the other end of the conversation just read out, and it is what the OTP flow signed them
 * in with. Everything ops does to one customer starts here.
 *
 * ── Why the lookup matches on a synthetic email too ────────────────────────────────────────────
 * Customers who signed in by OTP have no real address: the flow mints `<mobile>@…` so Medusa has
 * something unique to key on. For most of them that minted address is the only thing tying the
 * number they gave us to a customer row, so matching `phone` alone would miss them — which is to say
 * it would miss almost everybody.
 *
 * ── Why two matches is an error and not a choice ───────────────────────────────────────────────
 * Acting on the wrong one of two matches is a mistake that does not announce itself: the credit or
 * the generations land on a stranger, and the customer who called is still empty-handed and calls
 * again. Refusing sends the operator to a customer id, which is unambiguous.
 */

/**
 * One flat shape rather than a discriminated union: this project compiles without strictNullChecks,
 * and without it TypeScript will not narrow a union on a boolean tag — so callers would have to
 * cast, which is exactly the kind of thing that hides a real null later. `customerId` is the answer
 * when it is set, and `status`/`error` are what to reply with when it is not.
 */
export interface CustomerLookup {
  customerId: string | null
  status: 200 | 404 | 409
  error: string | null
}

export async function findCustomerByMobile(mobile: string): Promise<CustomerLookup> {
  /* Last ten digits, so +91, spaces and hyphens all land on the same row. */
  const digits = String(mobile).replace(/\D/g, "").slice(-10)

  if (digits.length < 10) {
    return { customerId: null, status: 404, error: "That does not look like a mobile number." }
  }

  const { rows } = await getWalletDbPool().query(
    `SELECT id FROM public.customer
      WHERE deleted_at IS NULL
        AND (phone = $1 OR email LIKE $2)
      ORDER BY created_at
      LIMIT 2`,
    [digits, `${digits}@%`]
  )

  if (rows.length === 0) {
    return { customerId: null, status: 404, error: "No customer has signed in with that number." }
  }
  if (rows.length > 1) {
    return {
      customerId: null,
      status: 409,
      error: "That number matches more than one customer. Use the customer id instead.",
    }
  }

  return { customerId: rows[0].id, status: 200, error: null }
}
