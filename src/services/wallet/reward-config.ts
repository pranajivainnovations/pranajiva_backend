import type { PoolClient } from "pg"

import { getWalletDbPool } from "./db"
import type { Brand } from "./ledger"

/**
 * Reading and writing the reward configuration.
 *
 * ── The shape is here, the values are in the database ──────────────────────────────────────────
 * The same split `settings/fields.ts` uses, for the same reason: which parameters exist and what
 * they mean is a decision, and decisions belong in code where they can be reviewed. The catalogue
 * below doubles as the write whitelist, so a mistyped key is refused rather than quietly stored as
 * a parameter nothing reads and everyone assumes is working.
 *
 * ── Percentages are basis points ───────────────────────────────────────────────────────────────
 * 500 bps is 5%. Never a float: 0.05 is not 0.05, and this system exists to keep a redemption cap
 * strictly below a gross margin — a comparison that must not turn on the seventeenth decimal place.
 */

export type Mechanic =
  | "economics"
  | "signup_bonus"
  | "joining_cash"
  | "referral"
  | "cashback"
  /**
   * The AI Studio. It issues no credit, so it is the one mechanic here that does not pay anybody —
   * it decides what a generation costs the customer and how many they get for nothing.
   *
   * It lives in this catalogue because everything that made this catalogue worth building applies to
   * it: the numbers are money, they must be movable without a deploy, they must be versioned so a
   * past charge stays explainable, and every change needs an author. What it does NOT use is the
   * grant limiters — max_grants and budget_paise count ledger rows, and a generation is not one.
   */
  | "studio"

/**
 * The mechanics that actually issue credit.
 *
 * `economics` holds the brand's margin numbers and pays nobody; `studio` prices compute and pays
 * nobody either. Everything that counts grants, sums issued money or maps a mechanic to a ledger
 * entry type wants this narrower set — spelling it once keeps those call sites from each carrying
 * their own exclusion list, which is how one of them ends up out of date.
 */
export type GrantMechanic = Exclude<Mechanic, "economics" | "studio">

export interface FieldSpec {
  key: string
  label: string
  /** paise for money, bps for rates, count for plain integers, days for durations. */
  unit: "paise" | "bps" | "count" | "days" | "boolean"
  required: boolean
  min?: number
  max?: number
  help: string
}

/**
 * Every parameter each mechanic may carry.
 *
 * Bounds are deliberately wide where the sensible value is a business decision and narrow where a
 * value outside them could only be a mistake. A referral rate of 60% is not a policy this system
 * should make possible to type; a referral rate of 2% is simply a choice.
 */
export const FIELDS: Record<Mechanic, FieldSpec[]> = {
  economics: [
    {
      key: "gross_margin_bps",
      label: "Gross margin",
      unit: "bps",
      required: true,
      min: 1,
      max: 10000,
      help: "What is left after the cost of fulfilling an order. Every guardrail measures against this, so a wrong figure here makes every other check wrong quietly.",
    },
    {
      key: "promo_redemption_cap_bps",
      label: "Promo redemption cap",
      unit: "bps",
      required: true,
      min: 1,
      max: 10000,
      help: "The most of an order a customer may pay from their wallet. 10000 is 100%, which lets a wallet cover an order outright. Set it per brand, or override it for one pincode during a launch. Above gross margin this costs you money per order on purpose — that is acquisition spend, and what bounds it is the budget and the per-customer earning cap, not this number.",
    },
    {
      key: "assumed_aov_paise",
      label: "Assumed average order value",
      unit: "paise",
      required: true,
      min: 1,
      help: "The order this brand's guardrails and previews are measured against. Not a limit on anything — change it and no customer is affected, but every warning about stacking and every 'you net ₹X' line moves with it.",
    },
  ],

  /**
   * The Studio.
   *
   * ── Why the free allowances are two numbers, not one ───────────────────────────────────────────
   * They buy different things. The anonymous allowance buys a landing page that works without a
   * login wall, which is an SEO position; the signed-in allowance buys the signup itself. Those are
   * worth different amounts and will be tuned against different evidence, so collapsing them into
   * one figure would make both untunable.
   *
   * Setting the anonymous allowance to 0 is how you keep today's behaviour, where generation
   * requires an account outright.
   *
   * ── Why what it costs us is configuration ──────────────────────────────────────────────────────
   * It is not a lever — nobody chooses their provider's bill. It is here so the guardrail has
   * something to compare the price against, and so the free allowance can be read as a rupee figure
   * rather than a count. A number that only exists in somebody's head cannot warn anyone.
   */
  studio: [
    { key: "free_anonymous", label: "Free generations, signed out", unit: "count", required: true, min: 0, max: 50,
      help: "What a visitor gets before we ask who they are. This is what makes the landing page work without a login wall — and it is also the only generation nobody can be held to, since there is no mobile behind it. 0 keeps the current behaviour, where signing in comes first." },
    { key: "free_signed_in", label: "Free generations after signing in", unit: "count", required: true, min: 0, max: 200,
      help: "What the signup itself buys, on top of the allowance above. Worth more than the compute at almost any sensible number — but multiply it by the unit cost below before setting it, because that product is what every signup costs you whether or not they ever order." },
    { key: "price_paise", label: "Price per extra generation", unit: "paise", required: true, min: 0,
      help: "Charged at the point of use once the free allowances are gone, and never taken from the wallet — credit given for marketing must not be spendable on compute. Set it above the unit cost or each extra generation loses money on purpose." },
    { key: "unit_cost_paise", label: "What one generation costs us", unit: "paise", required: true, min: 0,
      help: "The provider's bill for one generated design. Not a lever — it is here so the price can be checked against it and so a free allowance can be shown as rupees rather than a count." },
    { key: "refund_on_order", label: "Refund paid generations when they order", unit: "boolean", required: true,
      help: "On, the charge only ever lands on somebody who did not buy, which is the whole point of charging. Off, it becomes a revenue line — and a reason for your most serious customer to stop designing." },
    { key: "charge_failed", label: "A failed generation uses up an allowance", unit: "boolean", required: true,
      help: "Off is almost always right: a third of generations currently return no image, and taking somebody's free attempt for our failure is how they leave. It costs real compute either way, which is the argument for the other setting." },
  ],

  signup_bonus: [
    { key: "amount_paise", label: "Amount on joining", unit: "paise", required: true, min: 1,
      help: "Credited the moment somebody creates an account, before they have ordered anything. Unlike joining cash this is not earned, so what bounds it is the budget, the grant cap and the expiry rather than the cost of a cake." },
    { key: "expiry_days", label: "Expires in", unit: "days", required: true, min: 1, max: 365,
      help: "Days from joining. The whole purpose of this credit is to turn a signup into a first order, and credit with no deadline does not do that — it just sits on the books." },
  ],

  joining_cash: [
    { key: "grant_1_paise", label: "First grant", unit: "paise", required: true, min: 1,
      help: "Applied to the first order. Halves the first-order loss versus giving the whole amount at once." },
    { key: "grant_2_paise", label: "Second grant", unit: "paise", required: true, min: 1,
      help: "Applied to the second order. This is the one that buys the repeat the model depends on." },
    { key: "grant_2_expiry_days", label: "Second grant expires in", unit: "days", required: true, min: 1, max: 365,
      help: "Days from issue. Short enough to create urgency, long enough to be reachable." },
    { key: "min_order_paise", label: "Minimum order", unit: "paise", required: true, min: 1,
      help: "Below this the grant does not apply. Set so the grant stays under the redemption cap." },
    { key: "max_per_address", label: "Grants per delivery address", unit: "count",
      required: false, min: 1, max: 10,
      help: "How many different customers may earn this at one delivery address. One by default — the cheap version of the attack is several SIMs delivering to the same flat. Raise it for a shared address like a hostel, knowing what it permits." },
    { key: "prepaid_only", label: "Prepaid orders only", unit: "boolean", required: true,
      help: "Removes the refuse-delivery abuse path, where a cash order is rejected at the door after the reward has been earned." },
  ],

  referral: [
    { key: "rate_bps", label: "Rate", unit: "bps", required: true, min: 1, max: 2000,
      help: "Share of order value paid to the referrer. A percentage rather than a flat fee, so the referrer cares whether the person they brought actually buys." },
    { key: "per_order_cap_paise", label: "Cap per order", unit: "paise", required: true, min: 1,
      help: "The most any single order can pay a referrer, whatever its value." },
    { key: "window_orders", label: "Paid on first N orders", unit: "count", required: true, min: 1, max: 10,
      help: "How many of the referee's delivered orders earn the referrer anything." },
    { key: "hold_days", label: "Hold after delivery", unit: "days", required: true, min: 0, max: 60,
      help: "Days past delivery before credit is granted, so a return does not leave a reward already spent." },
    { key: "max_per_address", label: "Rewards per delivery address", unit: "count",
      required: false, min: 1, max: 20,
      help: "How many referral rewards may be earned from deliveries to one address. The cheap attack is a ring of accounts ordering to the same flat; this is what bounds it. Raise it for a hostel or an office, knowing what it permits." },
    { key: "monthly_cap_paise", label: "Most one referrer can earn a month", unit: "paise",
      required: false, min: 1,
      help: "Stops a single account accumulating faster than it can plausibly be worth. Leave empty for no monthly limit." },
    { key: "annual_cap_paise", label: "Most one referrer can earn a year", unit: "paise",
      required: false, min: 1,
      help: "The outer bound on one person's referral earnings. Around ₹1,000 is the spec's working figure. Leave empty for no annual limit." },
  ],

  cashback: [
    { key: "rate_bps", label: "Rate", unit: "bps", required: true, min: 1, max: 2000,
      help: "Share of order value returned as credit. The retention lever — the only one whose job is not acquisition." },
    { key: "hold_days", label: "Hold after delivery", unit: "days", required: true, min: 0, max: 60,
      help: "Days past delivery before credit is granted." },
    { key: "suppress_on_discounted_order", label: "Not paid on discounted orders", unit: "boolean", required: true,
      help: "Stops cashback stacking onto an order that promotional credit already paid part of, which together can exceed the margin." },
  ],
}

export interface RewardConfig {
  brand: Brand
  pincode: string | null
  mechanic: Mechanic
  version: number
  effectiveFrom: Date
  isEnabled: boolean
  startsAt: Date | null
  endsAt: Date | null
  maxGrants: number | null
  budgetPaise: number | null
  params: Record<string, number | boolean>
  /** Brand-level only: 'all' every pincode, 'selected' only those listed. Null on a pincode row. */
  scopeMode: ScopeMode | null
  scopePincodes: string[] | null
  note: string | null
  createdBy: string | null
  createdAt: Date
}

/**
 * A resolved configuration, and where each part of it came from.
 *
 * `source` is not diagnostics — it is what OPS renders. Without it somebody changes a brand default
 * and spends an hour wondering why four pincodes did not move, because the screen showed the
 * inherited value and the overridden one identically.
 */
export interface EffectiveConfig extends RewardConfig {
  brandVersion: number | null
  pincodeVersion: number | null
  source: Record<string, "brand" | "pincode">
}

function rowToConfig(r: Record<string, any>): RewardConfig {
  return {
    brand: r.brand,
    pincode: r.pincode,
    mechanic: r.mechanic,
    version: Number(r.version),
    effectiveFrom: r.effective_from,
    isEnabled: r.is_enabled === true,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    maxGrants: r.max_grants === null ? null : Number(r.max_grants),
    budgetPaise: r.budget_paise === null ? null : Number(r.budget_paise),
    scopeMode: (r.scope_mode ?? null) as ScopeMode | null,
    scopePincodes: r.scope_pincodes ?? null,
    params: r.params ?? {},
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }
}

/**
 * The version of one scope that was in force at a moment.
 *
 * Ordered by effective_from and then version, so two rows stamped the same instant — a double
 * submit, or a seed — still resolve to exactly one, and to the same one every time.
 */
async function versionAt(
  brand: Brand,
  pincode: string | null,
  mechanic: Mechanic,
  at: Date,
  client?: PoolClient
): Promise<RewardConfig | null> {
  const db = client ?? getWalletDbPool()
  const { rows } = await db.query(
    `SELECT * FROM wallet.reward_config
      WHERE brand = $1 AND mechanic = $2
        AND pincode IS NOT DISTINCT FROM $3
        AND effective_from <= $4
      ORDER BY effective_from DESC, version DESC
      LIMIT 1`,
    [brand, mechanic, pincode, at]
  )
  return rows[0] ? rowToConfig(rows[0]) : null
}

/** Fields a pincode row may override. Anything it leaves unset keeps coming from the brand. */
const OVERRIDABLE = ["isEnabled", "startsAt", "endsAt", "maxGrants", "budgetPaise"] as const

/**
 * The configuration actually in force for a brand, a pincode and a mechanic.
 *
 * ── Why a pincode row merges rather than replaces ──────────────────────────────────────────────
 * A launch offer in one pincode wants its own budget, its own grant cap and its own end date. It
 * does not want its own referral rate — the whole point of a brand default is that one edit moves
 * every pincode at once. Replacing wholesale would mean copying every rate into every pincode and
 * then maintaining them, which is how four pincodes end up paying four different rates nobody chose.
 *
 * `isEnabled` is deliberately overridable in both directions: a pincode may be switched off while
 * the brand runs, and switched on while the brand default is off — that second one is how a single
 * pincode gets piloted before anywhere else.
 *
 * Returns null when nothing is configured at either scope. That is not an error and must not be
 * treated as "use a default": a mechanic with no configuration has no rate, and inventing one is
 * how money gets given away at a number nobody chose.
 */
export async function getEffectiveConfig(
  brand: Brand,
  pincode: string | null,
  mechanic: Mechanic,
  at: Date = new Date(),
  client?: PoolClient
): Promise<EffectiveConfig | null> {
  const [brandRow, pincodeRow] = await Promise.all([
    versionAt(brand, null, mechanic, at, client),
    pincode ? versionAt(brand, pincode, mechanic, at, client) : Promise.resolve(null),
  ])

  if (!brandRow && !pincodeRow) return null

  const base = brandRow ?? pincodeRow!
  const merged: EffectiveConfig = {
    ...base,
    pincode,
    brandVersion: brandRow?.version ?? null,
    pincodeVersion: pincodeRow?.version ?? null,
    params: { ...(brandRow?.params ?? {}) },
    source: {},
  }

  /**
   * The scope always comes from the brand row, never from the spread above.
   *
   * When there is no brand row the base IS the pincode row, and a spread would have carried that
   * row's null through as though a scope had been considered and left empty. Stating it means the
   * absence of a brand row reads as "no list to be in" rather than "not in the list", which are
   * opposite answers for the pincode asking.
   */
  merged.scopeMode = brandRow?.scopeMode ?? null
  merged.scopePincodes = brandRow?.scopePincodes ?? null

  for (const key of Object.keys(merged.params)) merged.source[key] = "brand"
  for (const field of OVERRIDABLE) merged.source[field] = brandRow ? "brand" : "pincode"

  if (pincodeRow) {
    /**
     * Null means "not overridden here", so each limiter is taken only when the pincode row states
     * one. A pincode that wants NO end date on an offer the brand ends on the 31st cannot be
     * expressed this way — it has not come up, and "inherit unless stated" is what every screen and
     * every operator already expects.
     *
     * is_enabled is the exception, and deliberately so: the column is NOT NULL, so a pincode row
     * always carries an answer and always wins. Creating one IS the act of saying whether this
     * pincode runs, which is what allows a single pincode to be piloted while the brand default is
     * off — the launch shape the whole plan is built around.
     *
     * Written out rather than looped so the types hold. The loop that did this needed a cast to
     * Record<string, unknown>, which is exactly the cast that would let a renamed field start
     * silently failing to inherit.
     */
    merged.isEnabled = pincodeRow.isEnabled
    merged.source.isEnabled = "pincode"

    if (pincodeRow.startsAt !== null) {
      merged.startsAt = pincodeRow.startsAt
      merged.source.startsAt = "pincode"
    }
    if (pincodeRow.endsAt !== null) {
      merged.endsAt = pincodeRow.endsAt
      merged.source.endsAt = "pincode"
    }
    if (pincodeRow.maxGrants !== null) {
      merged.maxGrants = pincodeRow.maxGrants
      merged.source.maxGrants = "pincode"
    }
    if (pincodeRow.budgetPaise !== null) {
      merged.budgetPaise = pincodeRow.budgetPaise
      merged.source.budgetPaise = "pincode"
    }

    for (const [key, value] of Object.entries(pincodeRow.params)) {
      merged.params[key] = value as number | boolean
      merged.source[key] = "pincode"
    }
  }

  return merged
}

export class ConfigValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join(" "))
    this.name = "ConfigValidationError"
  }
}

/**
 * Checks a proposed parameter set against the catalogue.
 *
 * Refuses unknown keys as firmly as bad values. A parameter the catalogue does not list is one
 * nothing reads, and storing it produces a configuration screen that appears to offer a control
 * that does nothing — the most expensive kind of wrong, because it is invisible until the money is
 * already different from what somebody intended.
 *
 * ── Why "required" depends on the scope ────────────────────────────────────────────────────────
 * A brand default has to be complete: it is the only place a rate comes from, and a mechanic missing
 * one has no rate at all. A pincode row is the opposite — it exists precisely to state a few local
 * things and inherit everything else, and the common case is a launch that sets a budget and an end
 * date and touches no rate whatsoever. Demanding the full set there would force every rate to be
 * copied into every pincode and then maintained, which is how four pincodes end up paying four
 * different rates nobody chose.
 *
 * Every other check applies identically at both scopes: a rate overridden locally is still a rate,
 * and a local 90% is no more acceptable than a global one.
 */
export function validateParams(
  mechanic: Mechanic,
  params: Record<string, unknown>,
  options: { requireAll?: boolean } = {}
): string[] {
  const requireAll = options.requireAll ?? true
  const spec = FIELDS[mechanic]
  const problems: string[] = []
  const known = new Set(spec.map((f) => f.key))

  for (const key of Object.keys(params)) {
    if (!known.has(key)) problems.push(`"${key}" is not a ${mechanic} setting.`)
  }

  for (const field of spec) {
    const value = params[field.key]

    if (value === undefined || value === null) {
      if (field.required && requireAll) problems.push(`${field.label} is required.`)
      continue
    }

    if (field.unit === "boolean") {
      if (typeof value !== "boolean") problems.push(`${field.label} must be true or false.`)
      continue
    }

    if (typeof value !== "number" || !Number.isInteger(value)) {
      problems.push(`${field.label} must be a whole number.`)
      continue
    }
    if (field.min !== undefined && value < field.min) {
      problems.push(`${field.label} must be at least ${field.min}.`)
    }
    if (field.max !== undefined && value > field.max) {
      problems.push(`${field.label} must be at most ${field.max}.`)
    }
  }

  return problems
}

export type ScopeMode = "all" | "selected"

/**
 * A pincode list, tidied.
 *
 * Trimmed, de-duplicated and sorted, because the list is shown back to an operator and compared
 * between versions in the audit trail — "201016, 201014" and "201014, 201016 " are the same decision
 * and should not read as a change somebody made.
 */
function normalisePincodes(list: string[] | null | undefined): string[] | null {
  if (list === null || list === undefined) return null
  return [...new Set(list.map((p) => String(p).trim()).filter(Boolean))].sort()
}

export interface NewVersionInput {
  brand: Brand
  pincode?: string | null
  mechanic: Mechanic
  isEnabled: boolean
  /**
   * Where a brand-level offer runs. Ignored at pincode scope, where the row IS the scope.
   *
   * Omitting it on a serving mechanic's brand row carries the previous version's scope forward, so
   * stopping an offer does not lose the list of pincodes it ran in — the same reasoning as the bare
   * stop below. A scope has to be chosen once; it does not have to be restated to switch something
   * off and on again.
   */
  scopeMode?: ScopeMode | null
  scopePincodes?: string[] | null
  startsAt?: Date | null
  endsAt?: Date | null
  maxGrants?: number | null
  budgetPaise?: number | null
  params: Record<string, number | boolean>
  note?: string | null
  createdBy?: string | null
  effectiveFrom?: Date
}

/**
 * Writes a new version of one scope's configuration.
 *
 * The version number is computed inside the transaction, under a lock on the scope's existing rows,
 * because two operators saving at once would otherwise both read "2" and both try to write "3" —
 * and the unique index would reject the loser with a constraint error rather than the next number.
 *
 * Nothing is ever updated. The previous version stays exactly as it was, which is the only reason a
 * reward granted under it can still explain itself.
 */
export async function putVersion(input: NewVersionInput): Promise<RewardConfig> {
  const pincode = input.pincode ?? null

  const pool = getWalletDbPool()
  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    /**
     * An empty parameter set carries the previous version's forward.
     *
     * Switching a mechanic off is the case this exists for. Without it, stopping an offer would
     * mean re-stating every rate — the validator would refuse a brand-level version with no
     * parameters — and that is the "never refuse to stop" rule broken in the one place it is least
     * visible. Worse, an off version written with empty parameters would BECOME the effective
     * configuration, erasing the rates, so switching back on later would silently restore nothing.
     *
     * At pincode scope the same rule is a no-op in the common case, since a pincode row that
     * overrode nothing has nothing to carry, and it preserves a genuine local override when there
     * is one.
     */
    const { rows: previous } = await client.query(
      `SELECT params, starts_at, ends_at, max_grants, budget_paise, scope_mode, scope_pincodes
         FROM wallet.reward_config
        WHERE brand = $1 AND mechanic = $2 AND pincode IS NOT DISTINCT FROM $3
        ORDER BY version DESC LIMIT 1`,
      [input.brand, input.mechanic, pincode]
    )

    const priorVersion = previous[0]
    const params =
      Object.keys(input.params).length === 0 && priorVersion
        ? (priorVersion.params as Record<string, number | boolean>)
        : input.params

    /**
     * A bare stop changes the switch and nothing else.
     *
     * The limiters are not carried forward in general, because null is meaningful for each of them:
     * no end date, no grant cap, or — at pincode scope — inherit from the brand. Treating an omitted
     * budget as "keep the old one" would make clearing a limit impossible.
     *
     * But a call that supplies no parameters AND no limiters is not configuring anything; it is
     * saying stop. Taken literally it would write a version with no budget, which the guardrail then
     * refuses to switch back on — so stopping an offer would quietly destroy the thing needed to
     * restart it. This is the one case where silence means "unchanged" rather than "cleared".
     */
    const bare =
      Object.keys(input.params).length === 0 &&
      input.startsAt == null &&
      input.endsAt == null &&
      input.maxGrants == null &&
      input.budgetPaise == null &&
      Boolean(priorVersion)

    const limiters = bare
      ? {
          startsAt: priorVersion.starts_at as Date | null,
          endsAt: priorVersion.ends_at as Date | null,
          maxGrants: priorVersion.max_grants === null ? null : Number(priorVersion.max_grants),
          budgetPaise: priorVersion.budget_paise === null ? null : Number(priorVersion.budget_paise),
        }
      : {
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          maxGrants: input.maxGrants ?? null,
          budgetPaise: input.budgetPaise ?? null,
        }

    /* A brand default that is ON must be complete; a pincode override states only what it changes,
       and anything being switched off needs no rates at all to be switched off. */
    const problems = validateParams(input.mechanic, params, {
      requireAll: pincode === null && input.isEnabled,
    })

    /**
     * Where it runs.
     *
     * Only brand-level rows carry a scope — a pincode row is already about exactly one pincode, and
     * the database refuses a scope on one. Economics is not an offer and runs nowhere in particular.
     *
     * An omitted scope inherits the previous version's, so switching an offer off and on again keeps
     * the pincodes somebody chose. The one thing that is refused is switching a serving mechanic ON
     * for the first time without saying where: that used to mean "everywhere", and defaulting to
     * everywhere is the behaviour this whole change exists to remove.
     */
    /**
     * Which mechanics have to say where they run.
     *
     * Economics is the brand's numbers and runs nowhere in particular. The Studio is the second such
     * case: an image is generated, not delivered, so there is no area for it to run in and a scope
     * would be a control nobody could explain. Everything else — the welcome bonus included — has to
     * say where it runs.
     *
     * The database enforces the same two exemptions. Both are stated because this one produces a
     * sentence an operator reads, and a 23514 does not.
     */
    const servesSomewhere =
      pincode === null && input.mechanic !== "economics" && input.mechanic !== "studio"
    let scopeMode: ScopeMode | null = null
    let scopePincodes: string[] | null = null

    if (servesSomewhere) {
      scopeMode =
        input.scopeMode ?? ((priorVersion?.scope_mode ?? null) as ScopeMode | null)
      scopePincodes =
        input.scopeMode !== undefined && input.scopeMode !== null
          ? normalisePincodes(input.scopePincodes)
          : input.scopePincodes !== undefined
            ? normalisePincodes(input.scopePincodes)
            : ((priorVersion?.scope_pincodes ?? null) as string[] | null)

      if (!scopeMode) {
        problems.push(
          "Choose where this runs — a list of pincodes, or every pincode. There is no longer a " +
            "default, because the old default was every pincode and nothing said so."
        )
      }
      if (scopeMode === "selected" && scopePincodes === null) {
        problems.push("Selected scope needs a list of pincodes, even an empty one.")
      }
      for (const p of scopePincodes ?? []) {
        if (!/^[1-9][0-9]{5}$/.test(p)) problems.push(`"${p}" is not a pincode.`)
      }
      if (scopeMode === "all") scopePincodes = null
    }

    if (problems.length) throw new ConfigValidationError(problems)

    /**
     * Serialise writers to this one scope.
     *
     * An advisory lock rather than a row lock, for two reasons. Postgres refuses FOR UPDATE
     * alongside an aggregate, so "lock the rows and take MAX(version)" is not expressible in one
     * statement — and more importantly there is nothing to lock when a scope is being configured for
     * the first time, which is exactly when two operators are most likely to both be looking at an
     * empty screen. The lock is keyed on the scope, so configuring CrossFriend referral never waits
     * on somebody editing PranaJiva cashback, and it is released when the transaction ends.
     */
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `reward_config:${input.brand}:${pincode ?? ""}:${input.mechanic}`,
    ])

    const { rows: prior } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS v FROM wallet.reward_config
        WHERE brand = $1 AND mechanic = $2 AND pincode IS NOT DISTINCT FROM $3`,
      [input.brand, input.mechanic, pincode]
    )
    const version = Number(prior[0].v) + 1

    const { rows } = await client.query(
      `INSERT INTO wallet.reward_config
         (brand, pincode, mechanic, version, effective_from, is_enabled,
          starts_at, ends_at, max_grants, budget_paise, params, note, created_by,
          scope_mode, scope_pincodes)
       VALUES ($1,$2,$3,$4,COALESCE($5, NOW()),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.brand,
        pincode,
        input.mechanic,
        version,
        input.effectiveFrom ?? null,
        input.isEnabled,
        limiters.startsAt,
        limiters.endsAt,
        limiters.maxGrants,
        limiters.budgetPaise,
        JSON.stringify(params),
        input.note ?? null,
        input.createdBy ?? null,
        scopeMode,
        scopePincodes,
      ]
    )

    await client.query("COMMIT")
    return rowToConfig(rows[0])
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Every version of a scope, newest first — the audit view behind "why did this change?". */
export async function getHistory(
  brand: Brand,
  pincode: string | null,
  mechanic: Mechanic
): Promise<RewardConfig[]> {
  const { rows } = await getWalletDbPool().query(
    `SELECT * FROM wallet.reward_config
      WHERE brand = $1 AND mechanic = $2 AND pincode IS NOT DISTINCT FROM $3
      ORDER BY version DESC`,
    [brand, mechanic, pincode]
  )
  return rows.map(rowToConfig)
}

export interface FieldChange {
  field: string
  from: number | boolean | string | null
  to: number | boolean | string | null
}

export interface AuditEntry extends RewardConfig {
  /** The name behind created_by, because a UUID answers "who" only in principle. */
  createdByName: string | null
  /** What this version altered from the one before it. Empty on the first version. */
  changes: FieldChange[]
}

/** Fields worth reporting a change in. Ordered as they read, not as they are stored. */
const TRACKED: { key: keyof RewardConfig; label: string }[] = [
  { key: "isEnabled", label: "switched on" },
  { key: "budgetPaise", label: "budget" },
  { key: "maxGrants", label: "max grants" },
  { key: "startsAt", label: "opens" },
  { key: "endsAt", label: "closes" },
]

function asComparable(value: unknown): number | boolean | string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value
  }
  return String(value)
}

/**
 * The history of one scope, with each version's difference from the one before it.
 *
 * ── Why the diff is computed here rather than on screen ────────────────────────────────────────
 * Because an audit log of full snapshots is one nobody reads. The question is never "what were all
 * eleven settings in March", it is "what changed, and who changed it" — and answering that by
 * eyeballing two dense cards side by side is exactly the work a log exists to save. Doing it in the
 * service means every consumer gets the same answer and it is tested once.
 *
 * Parameters are diffed alongside the limiters, so a rate cut and a budget increase in the same
 * version read as two lines rather than as one opaque "changed".
 */
export async function getAuditTrail(
  brand: Brand,
  pincode: string | null,
  mechanic: Mechanic,
  limit = 50
): Promise<AuditEntry[]> {
  const safe = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 200) : 50

  const { rows } = await getWalletDbPool().query(
    `SELECT c.*, u.name AS created_by_name
       FROM wallet.reward_config c
       LEFT JOIN baker_network.ops_users u ON u.id = c.created_by
      WHERE c.brand = $1 AND c.mechanic = $2 AND c.pincode IS NOT DISTINCT FROM $3
      ORDER BY c.version DESC
      LIMIT $4`,
    [brand, mechanic, pincode, safe]
  )

  /* Oldest first while diffing, so each version is compared with the one it actually replaced. */
  const ascending = [...rows].reverse()
  const withChanges: AuditEntry[] = []

  for (let i = 0; i < ascending.length; i++) {
    const config = rowToConfig(ascending[i])
    const previous = i === 0 ? null : rowToConfig(ascending[i - 1])
    const changes: FieldChange[] = []

    if (previous) {
      for (const { key, label } of TRACKED) {
        const from = asComparable(previous[key])
        const to = asComparable(config[key])
        if (from !== to) changes.push({ field: label, from, to })
      }

      const keys = new Set([...Object.keys(previous.params), ...Object.keys(config.params)])
      for (const key of keys) {
        const from = asComparable(previous.params[key])
        const to = asComparable(config.params[key])
        if (from !== to) changes.push({ field: key, from, to })
      }
    }

    withChanges.push({
      ...config,
      createdByName: ascending[i].created_by_name ?? null,
      changes,
    })
  }

  /* Newest first for reading; the diffing above needed the other order. */
  return withChanges.reverse()
}
