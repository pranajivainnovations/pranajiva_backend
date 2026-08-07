/**
 * Authoritative pricing evaluator — reads the `pricing` schema (edited via OPS) and computes a real
 * price server-side, never trusting whatever total a client sends. Implements the resolution algorithm,
 * fallback behavior, and three-phase evaluation flow from the approved pricing engine design doc (see
 * AI-Context/PROJECT-TRACKER/STATUS.md → Checkout section for the link).
 *
 * Resolution rule, everywhere a rule is looked up: a region-specific row wins if one exists for the
 * resolved region, otherwise fall through to the `region_id IS NULL` (default) row. A pincode maps to
 * at most one region (`region_pincodes.pincode` UNIQUE), so there is never a region-vs-region conflict
 * to resolve — only "does this region have its own row, or not."
 */

import { getPricingDbPool } from "./db"

export type AdjustmentType = "flat" | "multiplier" | "per_kg" | "percentage"
export type CalculationTarget = "BASE" | "RUNNING_SUBTOTAL" | "FINAL_TOTAL"

const CALCULATORS: Record<AdjustmentType, (amount: number, target: number, weightKg: number) => number> = {
  flat: (amount) => amount,
  multiplier: (amount, target) => target * (amount - 1),
  per_kg: (amount, _target, weightKg) => amount * weightKg,
  percentage: (amount, target) => target * (amount / 100),
}

export interface BreakdownLine {
  label: string
  amount: number
  displayOrder: number
}

export interface EvaluatePriceInput {
  categoryKey: string
  pincode?: string
  weight: string
  /** attribute key -> selected value ('tiers': '2', 'shape': 'Heart') or boolean for toggle attributes */
  selections: Record<string, string | boolean | undefined>
  /**
   * Real Medusa add-on line items, pre-resolved by the caller. NOT re-verified against Medusa here —
   * this evaluator only owns cake-config pricing. Whatever route actually creates the cart/order line
   * items must resolve these amounts itself from Medusa's own product/variant service at that point,
   * not trust a value that merely passed through here.
   *
   * These amounts are added to the total verbatim, so they must NEVER originate from a request body:
   * a caller could post a negative amount and get a matching total back. /store/ai-studio/price
   * therefore does not expose this field at all — see its header comment.
   */
  addons?: { label: string; amount: number }[]
}

export interface EvaluatePriceResult {
  total: number
  breakdown: BreakdownLine[]
  ruleSetId: string
  regionId: string | null
  categoryId: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function evaluatePrice(input: EvaluatePriceInput): Promise<EvaluatePriceResult> {
  const pool = getPricingDbPool()

  // Every query below is issued in the smallest number of sequential rounds its data dependencies
  // allow. This used to be ~13 sequential round trips for a fully-specified cake (five lookups, then
  // two more per selected attribute inside a loop) — against a remote database that measured at
  // 1.7s for weight alone and 3.4s with six options selected, i.e. roughly half the request was the
  // loop. It is now three rounds regardless of how many attributes the customer picks.

  // ── Round 1: category and pincode→region are independent of each other ──
  const [categoryRes, regionRes] = await Promise.all([
    pool.query(`SELECT id FROM pricing.product_categories WHERE key = $1`, [input.categoryKey]),
    input.pincode
      ? pool.query(`SELECT region_id FROM pricing.region_pincodes WHERE pincode = $1`, [input.pincode])
      : Promise.resolve({ rows: [] as { region_id: string }[] }),
  ])

  const categoryId = categoryRes.rows[0]?.id
  if (!categoryId) {
    throw new Error(`[pricing] Unknown category: ${input.categoryKey}`)
  }
  const regionId: string | null = regionRes.rows[0]?.region_id ?? null

  // ── Round 2: rule set and the weight value both need only categoryId ──
  const [ruleSetRes, weightValueRes] = await Promise.all([
    pool.query(
      `SELECT id FROM pricing.rule_sets WHERE category_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
      [categoryId]
    ),
    pool.query(
      `SELECT av.id FROM pricing.attribute_values av
       JOIN pricing.attributes a ON a.id = av.attribute_id
       WHERE a.category_id = $1 AND a.key = 'weight' AND av.value = $2 AND av.is_active = true`,
      [categoryId, input.weight]
    ),
  ])

  const ruleSetId = ruleSetRes.rows[0]?.id
  if (!ruleSetId) {
    // Should never happen in practice — the OPS Publish action refuses to leave a category without a
    // published rule set. Treated as a hard error here rather than a silent fallback, since a caller
    // getting no price at all is safer than getting a fabricated one.
    throw new Error(`[pricing] No published rule set for category: ${input.categoryKey}`)
  }

  const weightValueId = weightValueRes.rows[0]?.id
  if (!weightValueId) {
    throw new Error(`[pricing] Unknown or inactive weight option: ${input.weight}`)
  }

  // Normalize the caller's selections into (attributeKey, valueToken) pairs up front so the whole set
  // can be resolved in one query instead of one pair of queries each.
  const selectionPairs: { key: string; token: string }[] = []
  for (const [key, rawValue] of Object.entries(input.selections)) {
    if (key === "weight") continue

    if (typeof rawValue === "boolean") {
      if (!rawValue) continue
      selectionPairs.push({ key, token: "on" })
    } else if (typeof rawValue === "string" && rawValue.length > 0) {
      selectionPairs.push({ key, token: rawValue })
    }
  }

  interface ResolvedAdjustment {
    calculationTarget: CalculationTarget
    adjustmentType: AdjustmentType
    amount: number
    label: string
    displayOrder: number
    evaluationOrder: number
  }

  // ── Round 3: base price, and every selection's adjustment rule, together ──
  //
  // The selections query unnests the (key, token) pairs into a derived table and joins the catalog
  // and the rule table in one pass. The LATERAL subquery reproduces the per-attribute resolution
  // exactly: a region-specific row wins, otherwise the region_id IS NULL default. A selection with no
  // matching attribute_value drops out via the inner join (unknown/inactive — ignored, as before);
  // one with no configured rule survives the LEFT JOIN with null columns and is skipped below (
  // selectable but free).
  const [baseRuleRes, selectionsRes] = await Promise.all([
    pool.query(
      `SELECT amount FROM pricing.base_price_rules
       WHERE rule_set_id = $1 AND weight_value_id = $2 AND (region_id = $3 OR region_id IS NULL)
       ORDER BY region_id IS NULL ASC
       LIMIT 1`,
      [ruleSetId, weightValueId, regionId]
    ),
    selectionPairs.length === 0
      ? Promise.resolve({ rows: [] as Record<string, unknown>[] })
      : pool.query(
          `SELECT av.label AS value_label,
                  ar.calculation_target, ar.adjustment_type, ar.amount,
                  ar.label AS rule_label, ar.display_order, ar.evaluation_order
           FROM unnest($1::text[], $2::text[]) AS sel(attr_key, attr_value)
           JOIN pricing.attributes a
             ON a.category_id = $3 AND a.key = sel.attr_key
           JOIN pricing.attribute_values av
             ON av.attribute_id = a.id AND av.value = sel.attr_value AND av.is_active = true
           LEFT JOIN LATERAL (
             SELECT calculation_target, adjustment_type, amount, label, display_order, evaluation_order
             FROM pricing.adjustment_rules
             WHERE rule_set_id = $4 AND attribute_value_id = av.id AND (region_id = $5 OR region_id IS NULL)
             ORDER BY region_id IS NULL ASC
             LIMIT 1
           ) ar ON true`,
          [
            selectionPairs.map((p) => p.key),
            selectionPairs.map((p) => p.token),
            categoryId,
            ruleSetId,
            regionId,
          ]
        ),
  ])

  if (baseRuleRes.rows.length === 0) {
    throw new Error(`[pricing] No base price configured for weight ${input.weight}`)
  }
  const base = Number(baseRuleRes.rows[0].amount)
  const weightKg = parseFloat(input.weight)

  const resolved: ResolvedAdjustment[] = []
  for (const row of selectionsRes.rows as Record<string, any>[]) {
    if (row.adjustment_type == null) continue // selectable but no price rule configured — no cost

    resolved.push({
      calculationTarget: row.calculation_target,
      adjustmentType: row.adjustment_type,
      amount: Number(row.amount),
      label: row.rule_label || row.value_label,
      displayOrder: row.display_order,
      evaluationOrder: row.evaluation_order,
    })
  }

  // Tie-break on label so the order is fully determined by the data. The batched query returns rows in
  // whatever order Postgres chooses rather than in the caller's selection order, so with a stable sort
  // alone two rules sharing an evaluation_order could otherwise apply in a different sequence between
  // runs — which changes the total, not just the display, once a RUNNING_SUBTOTAL multiplier is
  // involved. No rule set shares an evaluation_order today; this keeps that from becoming a silent
  // correctness bug if one ever does.
  resolved.sort((a, b) => a.evaluationOrder - b.evaluationOrder || a.label.localeCompare(b.label))

  const breakdown: BreakdownLine[] = [{ label: "Base Cake", amount: base, displayOrder: -1 }]
  let runningSubtotal = base

  // Phase 1 — cake: BASE / RUNNING_SUBTOTAL rules, in evaluation_order
  for (const rule of resolved) {
    if (rule.calculationTarget === "FINAL_TOTAL") continue
    const target = rule.calculationTarget === "BASE" ? base : runningSubtotal
    const contribution = round2(CALCULATORS[rule.adjustmentType](rule.amount, target, weightKg))
    runningSubtotal += contribution
    breakdown.push({ label: rule.label, amount: contribution, displayOrder: rule.displayOrder })
  }

  // Phase 2 — add-ons (real Medusa line items, pre-resolved by the caller). Round once and use that
  // same figure for both the running total and the breakdown line — adding the raw amount while
  // displaying a rounded one meant a breakdown could fail to sum to the total it was shown beside.
  for (const addon of input.addons ?? []) {
    const contribution = round2(addon.amount)
    runningSubtotal += contribution
    breakdown.push({ label: addon.label, amount: contribution, displayOrder: 1000 })
  }

  // Phase 3 — FINAL_TOTAL rules (e.g. Tax), against the post-add-on total
  for (const rule of resolved.filter((r) => r.calculationTarget === "FINAL_TOTAL")) {
    const contribution = round2(CALCULATORS[rule.adjustmentType](rule.amount, runningSubtotal, weightKg))
    runningSubtotal += contribution
    breakdown.push({ label: rule.label, amount: contribution, displayOrder: rule.displayOrder + 2000 })
  }

  const total = round2(runningSubtotal)
  const sortedBreakdown = [...breakdown].sort((a, b) => a.displayOrder - b.displayOrder)

  return { total, breakdown: sortedBreakdown, ruleSetId, regionId, categoryId }
}

export async function persistEvaluation(params: {
  result: EvaluatePriceResult
  pincode?: string
  selections: Record<string, unknown>
  customerId?: string
  orderId?: string
}): Promise<string> {
  const pool = getPricingDbPool()
  const res = await pool.query(
    `INSERT INTO pricing.price_evaluations
       (rule_set_id, region_id, category_id, pincode, selections, breakdown, total_amount, customer_id, order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      params.result.ruleSetId,
      params.result.regionId,
      params.result.categoryId,
      params.pincode ?? null,
      JSON.stringify(params.selections),
      JSON.stringify(params.result.breakdown),
      params.result.total,
      params.customerId ?? null,
      params.orderId ?? null,
    ]
  )
  return res.rows[0].id
}
