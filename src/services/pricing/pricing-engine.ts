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

  const categoryRes = await pool.query(`SELECT id FROM pricing.product_categories WHERE key = $1`, [input.categoryKey])
  const categoryId = categoryRes.rows[0]?.id
  if (!categoryId) {
    throw new Error(`[pricing] Unknown category: ${input.categoryKey}`)
  }

  const ruleSetRes = await pool.query(
    `SELECT id FROM pricing.rule_sets WHERE category_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
    [categoryId]
  )
  const ruleSetId = ruleSetRes.rows[0]?.id
  if (!ruleSetId) {
    // Should never happen in practice — the OPS Publish action refuses to leave a category without a
    // published rule set. Treated as a hard error here rather than a silent fallback, since a caller
    // getting no price at all is safer than getting a fabricated one.
    throw new Error(`[pricing] No published rule set for category: ${input.categoryKey}`)
  }

  let regionId: string | null = null
  if (input.pincode) {
    const regionRes = await pool.query(`SELECT region_id FROM pricing.region_pincodes WHERE pincode = $1`, [input.pincode])
    regionId = regionRes.rows[0]?.region_id ?? null
  }

  const weightValueRes = await pool.query(
    `SELECT av.id FROM pricing.attribute_values av
     JOIN pricing.attributes a ON a.id = av.attribute_id
     WHERE a.category_id = $1 AND a.key = 'weight' AND av.value = $2 AND av.is_active = true`,
    [categoryId, input.weight]
  )
  const weightValueId = weightValueRes.rows[0]?.id
  if (!weightValueId) {
    throw new Error(`[pricing] Unknown or inactive weight option: ${input.weight}`)
  }

  const baseRuleRes = await pool.query(
    `SELECT amount FROM pricing.base_price_rules
     WHERE rule_set_id = $1 AND weight_value_id = $2 AND (region_id = $3 OR region_id IS NULL)
     ORDER BY region_id IS NULL ASC
     LIMIT 1`,
    [ruleSetId, weightValueId, regionId]
  )
  if (baseRuleRes.rows.length === 0) {
    throw new Error(`[pricing] No base price configured for weight ${input.weight}`)
  }
  const base = Number(baseRuleRes.rows[0].amount)
  const weightKg = parseFloat(input.weight)

  interface ResolvedAdjustment {
    calculationTarget: CalculationTarget
    adjustmentType: AdjustmentType
    amount: number
    label: string
    displayOrder: number
    evaluationOrder: number
  }
  const resolved: ResolvedAdjustment[] = []

  for (const [key, rawValue] of Object.entries(input.selections)) {
    if (key === "weight") continue

    let valueToken: string | null = null
    if (typeof rawValue === "boolean") {
      if (!rawValue) continue
      valueToken = "on"
    } else if (typeof rawValue === "string" && rawValue.length > 0) {
      valueToken = rawValue
    } else {
      continue
    }

    const avRes = await pool.query(
      `SELECT av.id, av.label FROM pricing.attribute_values av
       JOIN pricing.attributes a ON a.id = av.attribute_id
       WHERE a.category_id = $1 AND a.key = $2 AND av.value = $3 AND av.is_active = true`,
      [categoryId, key, valueToken]
    )
    const av = avRes.rows[0]
    if (!av) continue // unknown/inactive attribute or value — ignore rather than fail the whole price

    const ruleRes = await pool.query(
      `SELECT calculation_target, adjustment_type, amount, label, display_order, evaluation_order
       FROM pricing.adjustment_rules
       WHERE rule_set_id = $1 AND attribute_value_id = $2 AND (region_id = $3 OR region_id IS NULL)
       ORDER BY region_id IS NULL ASC
       LIMIT 1`,
      [ruleSetId, av.id, regionId]
    )
    const rule = ruleRes.rows[0]
    if (!rule) continue // selectable but no price rule configured — treat as no additional cost

    resolved.push({
      calculationTarget: rule.calculation_target,
      adjustmentType: rule.adjustment_type,
      amount: Number(rule.amount),
      label: rule.label || av.label,
      displayOrder: rule.display_order,
      evaluationOrder: rule.evaluation_order,
    })
  }

  resolved.sort((a, b) => a.evaluationOrder - b.evaluationOrder)

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

  // Phase 2 — add-ons (real Medusa line items, pre-resolved by the caller)
  for (const addon of input.addons ?? []) {
    runningSubtotal += addon.amount
    breakdown.push({ label: addon.label, amount: round2(addon.amount), displayOrder: 1000 })
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
