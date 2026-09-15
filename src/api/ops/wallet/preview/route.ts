import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { checkProposal, previewAcrossSizes } from "../../../../services/wallet/guardrails"
import { validateParams, type Mechanic } from "../../../../services/wallet/reward-config"
import type { Brand } from "../../../../services/wallet/ledger"

/**
 * POST /ops/wallet/preview — what would happen if this configuration were saved.
 *
 * ── Writes nothing ─────────────────────────────────────────────────────────────────────────────
 * POST because the input is a whole proposed configuration rather than a handful of query
 * parameters, not because anything changes. No row is written, no version is created, and calling
 * it a hundred times while somebody types costs exactly four indexed reads each time.
 *
 * ── Why the arithmetic stays on this side ──────────────────────────────────────────────────────
 * The obvious way to make a figure update as you type is to compute it in the browser. That would
 * put the rule "a cap at or above margin loses money" in two languages, and the day they disagree
 * is the day the screen says one thing and the save refuses for another. So the form debounces and
 * asks, and there is exactly one implementation of what an offer costs.
 *
 * Returns the same shape the save path checks against, so a screen never shows a green preview for
 * something that is about to be refused.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    brand?: string
    pincode?: string | null
    mechanic?: string
    isEnabled?: boolean
    startsAt?: string | null
    endsAt?: string | null
    maxGrants?: number | null
    budgetPaise?: number | null
    params?: Record<string, number | boolean>
    sizes?: number[]
  }

  const brand = body.brand as Brand
  const mechanic = body.mechanic as Mechanic

  if (brand !== "crossfriend" && brand !== "pranajiva") {
    res.status(400).json({ error: "Unknown brand." })
    return
  }
  if (!["economics", "joining_cash", "referral", "cashback"].includes(mechanic)) {
    res.status(400).json({ error: "Unknown mechanic." })
    return
  }

  const pincode = body.pincode ?? null
  const params = body.params ?? {}

  try {
    /**
     * Field problems are reported beside the guardrails rather than instead of them.
     *
     * A half-typed form has both — a rate that is not a number yet, and a stacking warning from the
     * fields that are filled — and showing only the first means the warning appears for the first
     * time at the moment of saving, which is the moment it is least welcome.
     *
     * requireAll follows the same rule as the save path: a brand default that is ON must be
     * complete, a pincode override states only what it changes, and anything being switched off
     * needs no rates at all — stopping is never refused, here or there.
     */
    const fieldProblems = validateParams(mechanic, params, {
      requireAll: pincode === null && body.isEnabled === true,
    })

    const result = await checkProposal({
      brand,
      pincode,
      mechanic,
      isEnabled: body.isEnabled === true,
      startsAt: body.startsAt ? new Date(body.startsAt) : null,
      endsAt: body.endsAt ? new Date(body.endsAt) : null,
      maxGrants: body.maxGrants ?? null,
      budgetPaise: body.budgetPaise ?? null,
      params,
    })

    const sizes = previewAcrossSizes(
      result,
      Array.isArray(body.sizes) && body.sizes.length ? body.sizes : undefined
    )

    res.status(200).json({
      fieldProblems,
      blocks: result.blocks,
      warnings: result.warnings,
      /* Would the save button work? One boolean, so a screen does not have to re-derive the rule
         from two arrays and get it subtly different. */
      canSave: fieldProblems.length === 0 && result.blocks.length === 0,
      preview: result.preview,
      /* The same arithmetic at several order sizes, so the operator can see where an offer stops
         paying for itself rather than trusting one assumed average. */
      sizes,
      configured: {
        economics: result.resolved?.economics
          ? { version: result.resolved.economics.version, params: result.resolved.economics.params }
          : null,
        joining: summarise(result.resolved?.joining),
        cashback: summarise(result.resolved?.cashback),
        referral: summarise(result.resolved?.referral),
      },
    })
  } catch (error) {
    console.error("[ops/wallet/preview] failed", error)
    res.status(500).json({ error: "Could not work out what this would cost." })
  }
}

/**
 * "Not configured" and "configured but off" both contribute ₹0 and mean different things — one is
 * a lever nobody has set up, the other a lever somebody switched off. A screen showing a ₹0 line
 * needs to be able to say which.
 */
function summarise(config: { isEnabled: boolean; version: number } | null | undefined) {
  if (!config) return null
  return { isEnabled: config.isEnabled, version: config.version }
}
