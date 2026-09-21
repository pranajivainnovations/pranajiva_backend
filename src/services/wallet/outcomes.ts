import { getWalletDbPool } from "./db"
import type { Brand } from "./ledger"
import { getActivation, getRepeatRate, type ActivationReport, type RepeatReport } from "./cohorts"
import { evaluateMechanic, headroomFrom } from "./limiters"
import type { Mechanic, GrantMechanic } from "./reward-config"

/**
 * What a pincode's rewards actually did.
 *
 * ── Why credit is followed rather than counted twice ───────────────────────────────────────────
 * "Issued" is easy: sum the grants written here. "Redeemed" is the interesting half and is not a
 * sum of redemptions, because a redemption has no pincode of its own — credit earned in Indirapuram
 * can be spent on an order delivered anywhere, on either brand, which is the whole point of the
 * wallet. So redemption is attributed through the allocations: every movement records which grant it
 * consumed, and that grant knows where it was issued. The question this answers is the one worth
 * asking — "of the money we put into this pincode, how much came back as orders" — rather than
 * "how much was spent here", which is a different and much less useful number.
 *
 * ── What is deliberately absent ────────────────────────────────────────────────────────────────
 * Contribution margin at day 90, which is the figure the whole plan is meant to be judged on. It
 * needs order values and delivery dates, and reporting it from incentive spend alone would produce a
 * number that looks like margin and is not one. The panel says so rather than showing a plausible
 * fiction; the moment orders exist, this is where it goes.
 */

export interface MechanicOutcome {
  mechanic: Exclude<Mechanic, "economics">
  /** Whether it is running here, and if not, why. */
  state: string
  stateKind: "allowed" | "stopped" | "paused" | "unconfigured"
  explanation: string | null

  grants: number
  maxGrants: number | null
  grantsRemaining: number | null

  issuedPaise: number
  budgetPaise: number | null
  budgetRemainingPaise: number | null

  /** Of what was issued here, how much has been spent, lost to expiry, and is still owed. */
  redeemedPaise: number
  expiredPaise: number
  outstandingPaise: number

  customers: number
  /** Issued divided by the people it reached — the cost of a customer, as far as credit goes. */
  costPerCustomerPaise: number | null
}

export interface PincodeOutcomes {
  brand: Brand
  pincode: string
  mechanics: MechanicOutcome[]
  totals: {
    issuedPaise: number
    redeemedPaise: number
    expiredPaise: number
    outstandingPaise: number
    customers: number
  }
  /** The measurement the whole plan is judged on, and its baseline. */
  repeat: RepeatReport
  activation: ActivationReport
  /** Named so nobody mistakes an absence for a zero. */
  unavailable: string[]
}

const ENTRY_TYPE: Record<GrantMechanic, string> = {
  signup_bonus: "signup_bonus",
  joining_cash: "promo_grant",
  referral: "referral_earn",
  cashback: "cashback_earn",
}

const MECHANICS: GrantMechanic[] = [
  "signup_bonus",
  "joining_cash",
  "referral",
  "cashback",
]

/**
 * How credit issued in one pincode has been used.
 *
 * Splits the allocations by what consumed them, because the three outcomes mean different things:
 * redeemed is credit that did its job, expired is credit that was never wanted, and a reversal is
 * credit taken back. Lumping them together as "used" would hide the one that should change how an
 * offer is configured.
 */
async function creditFlow(brand: Brand, pincode: string, entryType: string) {
  const { rows } = await getWalletDbPool().query(
    `WITH issued AS (
       SELECT id, amount_paise, customer_id
         FROM wallet.entries
        WHERE brand = $1 AND pincode = $2 AND entry_type = $3
     ),
     consumed AS (
       SELECT a.grant_entry_id, m.entry_type AS by_type, SUM(a.amount_paise)::bigint AS taken
         FROM wallet.allocations a
         JOIN wallet.entries m ON m.id = a.consuming_entry_id
         JOIN issued i ON i.id = a.grant_entry_id
        WHERE NOT EXISTS (
          SELECT 1 FROM wallet.entries r
           WHERE r.entry_type = 'reversal' AND r.source_entry_id = m.id
        )
        GROUP BY 1, 2
     )
     SELECT
       (SELECT COUNT(*)::int FROM issued)                                   AS grants,
       (SELECT COUNT(DISTINCT customer_id)::int FROM issued)                AS customers,
       (SELECT COALESCE(SUM(amount_paise), 0)::bigint FROM issued)          AS issued,
       (SELECT COALESCE(SUM(taken), 0)::bigint FROM consumed
         WHERE by_type = 'redemption')                                      AS redeemed,
       (SELECT COALESCE(SUM(taken), 0)::bigint FROM consumed
         WHERE by_type = 'expiry')                                          AS expired,
       (SELECT COALESCE(SUM(taken), 0)::bigint FROM consumed
         WHERE by_type = 'reversal')                                        AS reversed`,
    [brand, pincode, entryType]
  )

  const r = rows[0]
  const issued = Number(r.issued)
  const redeemed = Number(r.redeemed)
  const expired = Number(r.expired)
  const reversed = Number(r.reversed)

  return {
    grants: r.grants as number,
    customers: r.customers as number,
    issuedPaise: issued,
    redeemedPaise: redeemed,
    expiredPaise: expired,
    /* What is still owed from what was issued here. Reversals are subtracted because that credit
       was taken back rather than spent — counting it as outstanding would overstate the liability
       by exactly the amount that was clawed back. */
    outstandingPaise: issued - redeemed - expired - reversed,
  }
}

export async function getPincodeOutcomes(
  brand: Brand,
  pincode: string
): Promise<PincodeOutcomes> {
  const mechanics = await Promise.all(
    MECHANICS.map(async (mechanic): Promise<MechanicOutcome> => {
      /* The same evaluator the grant path uses, so the panel says what an order would actually
         meet rather than a second opinion about it. */
      const verdict = await evaluateMechanic({ brand, pincode, mechanic })
      const headroom = headroomFrom(verdict)
      const flow = await creditFlow(brand, pincode, ENTRY_TYPE[mechanic])

      return {
        mechanic,
        state: verdict.reason ?? "running",
        stateKind: verdict.kind,
        explanation: verdict.explanation,

        grants: flow.grants,
        maxGrants: verdict.config?.maxGrants ?? null,
        grantsRemaining: headroom.grantsRemaining,

        issuedPaise: flow.issuedPaise,
        budgetPaise: verdict.config?.budgetPaise ?? null,
        budgetRemainingPaise: headroom.budgetRemainingPaise,

        redeemedPaise: flow.redeemedPaise,
        expiredPaise: flow.expiredPaise,
        outstandingPaise: flow.outstandingPaise,

        customers: flow.customers,
        costPerCustomerPaise:
          flow.customers > 0 ? Math.round(flow.issuedPaise / flow.customers) : null,
      }
    })
  )

  /**
   * Customers counted once across mechanics, not summed.
   *
   * Somebody who took joining cash and later earned cashback is one customer reached, and adding
   * the per-mechanic counts would report them as two — which quietly halves the cost per customer,
   * the one figure on this panel a decision gets made on.
   */
  const { rows: reached } = await getWalletDbPool().query(
    `SELECT COUNT(DISTINCT customer_id)::int AS n
       FROM wallet.entries
      WHERE brand = $1 AND pincode = $2
        AND entry_type IN ('promo_grant', 'referral_earn', 'cashback_earn')`,
    [brand, pincode]
  )

  const [repeat, activation] = await Promise.all([
    getRepeatRate({ brand, pincode }),
    getActivation({}),
  ])

  return {
    brand,
    pincode,
    mechanics,
    repeat,
    activation,
    totals: {
      issuedPaise: mechanics.reduce((s, m) => s + m.issuedPaise, 0),
      redeemedPaise: mechanics.reduce((s, m) => s + m.redeemedPaise, 0),
      expiredPaise: mechanics.reduce((s, m) => s + m.expiredPaise, 0),
      outstandingPaise: mechanics.reduce((s, m) => s + m.outstandingPaise, 0),
      customers: reached[0].n,
    },
    /**
     * Stated rather than silently omitted.
     *
     * The plan is meant to be judged on 90-day repeat rate and contribution margin after incentives,
     * and neither can be computed from the ledger alone — both need order values and delivery dates.
     * A panel that simply left them out would read as though incentive spend were the whole picture,
     * which is the reading that makes a cheap offer look like a good one.
     */
    unavailable: [
      "Contribution margin after incentives — needs order values. Medusa computes an order's total " +
        "from its line items rather than storing one, so this arrives with the first orders.",
      "Activation per pincode — a customer's pincode comes from their first order, so everyone who " +
        "has one has ordered. Brand-wide activation is reported instead.",
    ],
  }
}
