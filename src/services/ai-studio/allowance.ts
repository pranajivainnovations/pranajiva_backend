import { getWalletDbPool } from "../wallet/db"
import type { Brand } from "../wallet/ledger"
import { getEffectiveConfig } from "../wallet/reward-config"

/**
 * May this customer generate another design, and how many have they got left?
 *
 * ── Why this is server-side, which is the whole point of it ────────────────────────────────────
 * The storefront has had a limit since the Studio shipped: `freeAttemptsLimit` in a JSON file, held
 * in React state. It survives until the page is refreshed. At roughly ₹5 of compute a generation,
 * that is not a limit — it is a label, and the only thing standing between one determined visitor
 * and an unbounded Replicate bill is that nobody has tried.
 *
 * So the count is taken from the generations table, which is the record of what was actually spent,
 * and the check happens before the provider is called rather than after.
 *
 * ── Why failures do not normally count ─────────────────────────────────────────────────────────
 * A third of the generations in production failed — 26 of the first 82. Those failures are ours:
 * provider timeouts, refused prompts, upload errors. Charging an attempt for each would take three
 * of a customer's ten for things they never received, and the complaint would be entirely fair.
 * `charge_failed` exists so that is a decision an operator makes rather than a behaviour baked in,
 * and it defaults to off.
 *
 * ── Why the allowance is config plus grants ────────────────────────────────────────────────────
 * The base number moves for everybody at once and belongs in reward_config, where it is versioned
 * and audited like every other lever. What one particular customer gets after a conversation with
 * support belongs to that customer, and is a row in ai_studio.generation_grants naming who gave it
 * and why. Adding the two is the whole rule; there is no third source and no per-customer override
 * that silently replaces the base.
 */

/** What the Studio config means, with the defaults used when nothing has been configured yet. */
export interface StudioLimits {
  freeSignedIn: number
  chargeFailed: boolean
}

export interface Allowance {
  /** Base allowance from config, before anything given by hand. */
  basePaid: number
  /** The sum of every manual grant to this customer. */
  grantedExtra: number
  /** basePaid + grantedExtra. */
  total: number
  /** Generations that consumed an attempt — see chargeFailed. */
  used: number
  /** Never negative: somebody whose base was lowered below what they have already used reads 0. */
  remaining: number
  allowed: boolean
  chargeFailed: boolean
}

/**
 * The Studio's limits as currently configured.
 *
 * Falls back to a conservative default rather than throwing. A config read that fails must not take
 * the Studio down with it — but it must not open the tap either, so the fallback is the smaller of
 * the two numbers we would ever have set, not unlimited.
 */
export async function getStudioLimits(brand: Brand = "crossfriend"): Promise<StudioLimits> {
  try {
    const config = await getEffectiveConfig(brand, null, "studio")
    if (!config?.isEnabled) {
      /* Not switched on. The Studio still runs — this mechanic meters it, it does not gate it —
         so the base allowance stands and only the operator's numbers are absent. */
      return { freeSignedIn: DEFAULT_FREE_SIGNED_IN, chargeFailed: false }
    }
    const params = (config.params ?? {}) as Record<string, unknown>
    return {
      freeSignedIn: asCount(params.free_signed_in, DEFAULT_FREE_SIGNED_IN),
      chargeFailed: params.charge_failed === true,
    }
  } catch {
    return { freeSignedIn: DEFAULT_FREE_SIGNED_IN, chargeFailed: false }
  }
}

const DEFAULT_FREE_SIGNED_IN = 10

function asCount(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * Everything about one customer's standing, in a single round trip.
 *
 * Both counts come from one query on purpose. Asking for the used count and the granted total
 * separately leaves a window in which a grant lands between them, and the customer is told a number
 * that was never true.
 */
export async function getAllowance(
  customerId: string,
  brand: Brand = "crossfriend"
): Promise<Allowance> {
  const limits = await getStudioLimits(brand)
  const pool = getWalletDbPool()

  /**
   * Two queries rather than one, for a reason worth stating.
   *
   * They were a single statement until a production check caught what that costs: the grants table
   * arrives in a migration, and between the code shipping and the migration running it does not
   * exist. One statement means the whole allowance throws, the generate route 500s, and the Studio
   * is down for everybody — because of a table that only ever ADDS to what somebody may do.
   *
   * Split, a missing or failing grants table costs exactly the grants. Everyone still gets their
   * configured allowance, and the only people affected are those who had been topped up by hand,
   * who are briefly back to the base. That is the right way round: a failure in the generous half
   * should never be able to lock out the ordinary half.
   */
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS used
       FROM ai_studio.generations
      WHERE customer_id = $1
        AND (status = 'completed' OR ($2::boolean AND status = 'failed'))`,
    [customerId, limits.chargeFailed]
  )

  const grantedExtra = await sumGrants(pool, customerId)
  const used = rows[0]?.used ?? 0
  const total = limits.freeSignedIn + grantedExtra
  const remaining = Math.max(0, total - used)

  return {
    basePaid: limits.freeSignedIn,
    grantedExtra,
    total,
    used,
    remaining,
    allowed: remaining > 0,
    chargeFailed: limits.chargeFailed,
  }
}

/**
 * What has been given to this customer by hand, or zero if that cannot be read.
 *
 * Logged rather than swallowed quietly: zero grants is a survivable answer, but it is not a correct
 * one, and a customer who was topped up and is being refused anyway should leave a trace of why.
 */
async function sumGrants(pool: { query: Function }, customerId: string): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS granted
         FROM ai_studio.generation_grants
        WHERE customer_id = $1`,
      [customerId]
    )
    return rows[0]?.granted ?? 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ai-studio/allowance] could not read grants for ${customerId}: ${message}`)
    return 0
  }
}

/**
 * Give a customer more generations.
 *
 * Both the reason and the author are required by the database, not merely by this function — a
 * grant that cannot say who made it or why is not a grant anybody can defend later.
 */
export async function grantGenerations(input: {
  customerId: string
  amount: number
  reason: string
  createdBy: string
}): Promise<{ id: string; createdAt: string }> {
  const pool = getWalletDbPool()

  const { rows } = await pool.query(
    `INSERT INTO ai_studio.generation_grants (customer_id, amount, reason, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [input.customerId, Math.floor(input.amount), input.reason.trim(), input.createdBy]
  )

  return { id: rows[0].id, createdAt: rows[0].created_at }
}
