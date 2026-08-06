/**
 * Generic product-configuration constraints engine — answers "what combinations are allowed" for any
 * category, entirely independent of pricing (which answers "how much"). No category or attribute name
 * is ever hardcoded here: every attribute key, value, and rule comes from the `pricing.attributes` /
 * `pricing.attribute_values` catalog and the `constraints.*` schema (see
 * src/migrations/1723100000000-CreateConstraintsSchema.ts for the full schema rationale).
 *
 * Structured as four explicit phases, composed by the one exported function:
 *   resolveContext   — load the category's full option space, resolve the caller's selections to real
 *                       attribute_value ids, load the active (published) rule set's rules.
 *   evaluateTriggers  — for each rule, decide whether its condition is currently satisfied.
 *   applyRuleEffects  — for every triggered rule, mark its target attribute's values enabled/disabled/
 *                       recommended across the whole option space (not just the caller's selection).
 *   validateSelections — check whether the caller's own current selections are themselves still valid
 *                       given the option space just computed.
 *
 * Disabling is a union across rules (once a value is disabled, it stays disabled) — independently
 * evaluating every triggered rule this way is equivalent to intersecting numeric bounds and letting
 * "forbidden" win, without a separate conflict-merge step. `priority` only affects which rule's message
 * is surfaced first when multiple rules disable the same value, never which rule "wins."
 */

import { getConstraintsDbPool } from "./db"

export type TriggerOperator = "EQUALS" | "NOT_EQUALS" | "IN" | "NOT_IN" | "MIN_VALUE" | "MAX_VALUE"
export type RuleKind = "MIN_VALUE" | "MAX_VALUE" | "ALLOWED_VALUES" | "FORBIDDEN_VALUES" | "RECOMMENDED_VALUES"

export interface EvaluateConstraintsInput {
  categoryKey: string
  /** attribute key -> currently selected value, e.g. {weight: "1", tiers: "3"}. Missing/unknown keys are fine. */
  selections: Record<string, string | undefined>
}

export interface AttributeValueState {
  valueId: string
  value: string
  enabled: boolean
  recommended: boolean
  reason?: string
}

export interface AttributeOptionState {
  attributeKey: string
  values: AttributeValueState[]
}

export interface ConstraintViolation {
  attributeKey: string
  message: string
}

export interface EvaluateConstraintsResult {
  options: AttributeOptionState[]
  violations: ConstraintViolation[]
}

// ─── Internal shapes ─────────────────────────────────────────────────────────

interface CatalogValue {
  id: string
  value: string
}

interface CatalogAttribute {
  attributeId: string
  key: string
  values: CatalogValue[]
}

interface ResolvedRule {
  id: string
  triggerAttributeKey: string | null
  triggerOperator: TriggerOperator | null
  triggerNumericValue: number | null
  triggerValueIds: string[]
  targetAttributeKey: string
  kind: RuleKind
  numericValue: number | null
  valueIds: string[]
  message: string
  priority: number
}

interface ConstraintContext {
  categoryId: string
  catalog: CatalogAttribute[]
  selectedValueIds: Record<string, string>   // attributeKey -> valueId, only for selections that resolved
  rules: ResolvedRule[]
}

// ─── Cache — new to this service; pricing-engine.ts has no equivalent (confirmed by reading it), so
// there's no existing pattern to mirror. Rule sets change rarely (an OPS publish), so a short TTL cuts
// repeated DB round trips within a single customer session without meaningfully risking staleness. ───

const CACHE_TTL_MS = 30_000
const ruleSetCache = new Map<string, { categoryId: string; rules: ResolvedRule[]; expiresAt: number }>()

async function loadRuleSetForCategory(
  categoryKey: string
): Promise<{ categoryId: string; rules: ResolvedRule[] } | null> {
  const cached = ruleSetCache.get(categoryKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { categoryId: cached.categoryId, rules: cached.rules }
  }

  const pool = getConstraintsDbPool()

  const categoryRes = await pool.query(`SELECT id FROM pricing.product_categories WHERE key = $1`, [categoryKey])
  const categoryId = categoryRes.rows[0]?.id
  if (!categoryId) {
    throw new Error(`[constraints] Unknown category: ${categoryKey}`)
  }

  const ruleSetRes = await pool.query(
    `SELECT id FROM constraints.rule_sets WHERE category_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
    [categoryId]
  )
  const ruleSetId = ruleSetRes.rows[0]?.id

  if (!ruleSetId) {
    // Unlike pricing (which requires a published rule set to price anything), no published constraint
    // rule set is a perfectly normal state — it just means nothing is constrained yet.
    const result = { categoryId, rules: [] }
    ruleSetCache.set(categoryKey, { ...result, expiresAt: Date.now() + CACHE_TTL_MS })
    return result
  }

  const rulesRes = await pool.query(
    `SELECT r.id, r.trigger_operator, r.trigger_numeric_value, r.kind, r.numeric_value, r.message, r.priority,
            ta.key AS trigger_attribute_key, tga.key AS target_attribute_key
     FROM constraints.rules r
     JOIN pricing.attributes tga ON tga.id = r.target_attribute_id
     LEFT JOIN pricing.attributes ta ON ta.id = r.trigger_attribute_id
     WHERE r.rule_set_id = $1`,
    [ruleSetId]
  )
  const ruleIds: string[] = rulesRes.rows.map((r) => r.id)

  const valuesByRule = new Map<string, string[]>()
  const triggerValuesByRule = new Map<string, string[]>()

  if (ruleIds.length > 0) {
    const valuesRes = await pool.query(
      `SELECT rule_id, array_agg(attribute_value_id) AS value_ids FROM constraints.rule_values WHERE rule_id = ANY($1) GROUP BY rule_id`,
      [ruleIds]
    )
    for (const row of valuesRes.rows) valuesByRule.set(row.rule_id, row.value_ids)

    const triggerValuesRes = await pool.query(
      `SELECT rule_id, array_agg(attribute_value_id) AS value_ids FROM constraints.rule_trigger_values WHERE rule_id = ANY($1) GROUP BY rule_id`,
      [ruleIds]
    )
    for (const row of triggerValuesRes.rows) triggerValuesByRule.set(row.rule_id, row.value_ids)
  }

  const rules: ResolvedRule[] = rulesRes.rows.map((r) => ({
    id: r.id,
    triggerAttributeKey: r.trigger_attribute_key ?? null,
    triggerOperator: r.trigger_operator ?? null,
    triggerNumericValue: r.trigger_numeric_value != null ? Number(r.trigger_numeric_value) : null,
    triggerValueIds: triggerValuesByRule.get(r.id) ?? [],
    targetAttributeKey: r.target_attribute_key,
    kind: r.kind,
    numericValue: r.numeric_value != null ? Number(r.numeric_value) : null,
    valueIds: valuesByRule.get(r.id) ?? [],
    message: r.message,
    priority: r.priority,
  }))

  const result = { categoryId, rules }
  ruleSetCache.set(categoryKey, { ...result, expiresAt: Date.now() + CACHE_TTL_MS })
  return result
}

// ─── Phase 1 — resolve ────────────────────────────────────────────────────────

async function resolveContext(categoryKey: string, selections: Record<string, string | undefined>): Promise<ConstraintContext> {
  const { categoryId, rules } = (await loadRuleSetForCategory(categoryKey))!

  const pool = getConstraintsDbPool()
  const catalogRes = await pool.query(
    `SELECT a.id AS attribute_id, a.key AS attribute_key, av.id AS value_id, av.value
     FROM pricing.attributes a
     JOIN pricing.attribute_values av ON av.attribute_id = a.id
     WHERE a.category_id = $1 AND a.is_active = true AND av.is_active = true
     ORDER BY a.sort_order, av.sort_order`,
    [categoryId]
  )

  const catalogByKey = new Map<string, CatalogAttribute>()
  for (const row of catalogRes.rows) {
    let entry = catalogByKey.get(row.attribute_key)
    if (!entry) {
      entry = { attributeId: row.attribute_id, key: row.attribute_key, values: [] }
      catalogByKey.set(row.attribute_key, entry)
    }
    entry.values.push({ id: row.value_id, value: row.value })
  }
  const catalog = [...catalogByKey.values()]

  const selectedValueIds: Record<string, string> = {}
  for (const [key, value] of Object.entries(selections)) {
    if (!value) continue
    const match = catalogByKey.get(key)?.values.find((v) => v.value === value)
    if (match) selectedValueIds[key] = match.id
  }

  return { categoryId, catalog, selectedValueIds, rules }
}

// ─── Phase 2 — evaluate triggers ──────────────────────────────────────────────

function isRuleTriggered(rule: ResolvedRule, ctx: ConstraintContext): boolean {
  if (!rule.triggerAttributeKey || !rule.triggerOperator) return true // unconditional

  const selectedId = ctx.selectedValueIds[rule.triggerAttributeKey]

  if (rule.triggerOperator === "MIN_VALUE" || rule.triggerOperator === "MAX_VALUE") {
    const attr = ctx.catalog.find((a) => a.key === rule.triggerAttributeKey)
    const selectedValue = attr?.values.find((v) => v.id === selectedId)?.value
    if (selectedValue == null || rule.triggerNumericValue == null) return false
    const numeric = parseFloat(selectedValue)
    if (Number.isNaN(numeric)) return false
    return rule.triggerOperator === "MIN_VALUE" ? numeric >= rule.triggerNumericValue : numeric <= rule.triggerNumericValue
  }

  if (!selectedId) return false
  const inSet = rule.triggerValueIds.includes(selectedId)
  switch (rule.triggerOperator) {
    case "EQUALS":
    case "IN":
      return inSet
    case "NOT_EQUALS":
    case "NOT_IN":
      return !inSet
    default:
      return false
  }
}

function evaluateTriggers(ctx: ConstraintContext): ResolvedRule[] {
  return ctx.rules.filter((rule) => isRuleTriggered(rule, ctx))
}

// ─── Phase 3 — apply rule effects across the whole option space ──────────────

function applyRuleEffects(ctx: ConstraintContext, triggeredRules: ResolvedRule[]): AttributeOptionState[] {
  const options: AttributeOptionState[] = ctx.catalog.map((attr) => ({
    attributeKey: attr.key,
    values: attr.values.map((v) => ({ valueId: v.id, value: v.value, enabled: true, recommended: false })),
  }))
  const optionsByKey = new Map(options.map((o) => [o.attributeKey, o]))

  // Rules that disable are applied first, highest priority first, so a lower-priority rule's message
  // never overwrites a higher-priority one's on the same value; recommendations applied after so they
  // never get clobbered by a later disable's reason on the same value.
  const sorted = [...triggeredRules].sort((a, b) => b.priority - a.priority)

  for (const rule of sorted) {
    const target = optionsByKey.get(rule.targetAttributeKey)
    if (!target) continue

    for (const valueState of target.values) {
      let disables = false
      switch (rule.kind) {
        case "MIN_VALUE": {
          const numeric = parseFloat(valueState.value)
          disables = !Number.isNaN(numeric) && rule.numericValue != null && numeric < rule.numericValue
          break
        }
        case "MAX_VALUE": {
          const numeric = parseFloat(valueState.value)
          disables = !Number.isNaN(numeric) && rule.numericValue != null && numeric > rule.numericValue
          break
        }
        case "ALLOWED_VALUES":
          disables = !rule.valueIds.includes(valueState.valueId)
          break
        case "FORBIDDEN_VALUES":
          disables = rule.valueIds.includes(valueState.valueId)
          break
        case "RECOMMENDED_VALUES":
          if (rule.valueIds.includes(valueState.valueId)) {
            valueState.recommended = true
            if (!valueState.reason) valueState.reason = rule.message
          }
          continue
      }

      if (disables && valueState.enabled) {
        valueState.enabled = false
        valueState.reason = rule.message
      }
    }
  }

  return options
}

// ─── Phase 4 — validate the caller's own current selections ──────────────────

function validateSelections(ctx: ConstraintContext, options: AttributeOptionState[]): ConstraintViolation[] {
  const violations: ConstraintViolation[] = []
  const optionsByKey = new Map(options.map((o) => [o.attributeKey, o]))

  for (const [attributeKey, valueId] of Object.entries(ctx.selectedValueIds)) {
    const state = optionsByKey.get(attributeKey)?.values.find((v) => v.valueId === valueId)
    if (state && !state.enabled) {
      violations.push({ attributeKey, message: state.reason ?? `${attributeKey} is not allowed with the current selection.` })
    }
  }

  return violations
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function evaluateConstraints(input: EvaluateConstraintsInput): Promise<EvaluateConstraintsResult> {
  const ctx = await resolveContext(input.categoryKey, input.selections)
  const triggered = evaluateTriggers(ctx)
  const options = applyRuleEffects(ctx, triggered)
  const violations = validateSelections(ctx, options)
  return { options, violations }
}
