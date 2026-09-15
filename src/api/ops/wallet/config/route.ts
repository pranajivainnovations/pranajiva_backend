import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import { checkProposal } from "../../../../services/wallet/guardrails"
import {
  ConfigValidationError,
  FIELDS,
  getEffectiveConfig,
  getHistory,
  putVersion,
  type Mechanic,
} from "../../../../services/wallet/reward-config"
import type { Brand } from "../../../../services/wallet/ledger"

const MECHANICS: Mechanic[] = ["economics", "joining_cash", "referral", "cashback"]

function readScope(q: Record<string, unknown>) {
  const brand = String(q.brand ?? "") as Brand
  const pincode = q.pincode ? String(q.pincode) : null
  return { brand, pincode }
}

/**
 * GET /ops/wallet/config?brand=…&pincode=… — everything in force for a scope.
 *
 * Returns each mechanic's effective configuration together with the per-field `source` map, so a
 * screen can show inherited and overridden values differently. Without that distinction somebody
 * changes a brand default and spends an hour wondering why four pincodes did not move.
 *
 * The field catalogue comes back too. It is the same one the save path validates against, so a form
 * built from it cannot offer a control the backend will reject as unknown.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const { brand, pincode } = readScope(req.query as Record<string, unknown>)
  if (brand !== "crossfriend" && brand !== "pranajiva") {
    res.status(400).json({ error: "Unknown brand." })
    return
  }

  try {
    const entries = await Promise.all(
      MECHANICS.map(async (mechanic) => [
        mechanic,
        await getEffectiveConfig(brand, pincode, mechanic),
      ] as const)
    )

    res.status(200).json({
      brand,
      pincode,
      fields: FIELDS,
      config: Object.fromEntries(entries),
    })
  } catch (error) {
    console.error("[ops/wallet/config] read failed", error)
    res.status(500).json({ error: "Could not read the reward configuration." })
  }
}

/**
 * POST /ops/wallet/config — write a new version.
 *
 * ── Why the guardrails run here and not only in the form ───────────────────────────────────────
 * Because the form is not the only caller and will not always be the caller. A screen that checks
 * before submitting is a convenience; the check that decides is the one on the write path, where it
 * cannot be skipped by a stale tab, a replayed request, or a future script somebody writes in a
 * hurry. The preview endpoint runs exactly this logic so the two can never disagree.
 *
 * Blocks refuse the write. Warnings do not — they are judgements the operator is entitled to make,
 * and they come back in the response so the screen can show what was accepted alongside what it
 * cost.
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
    note?: string
    opsUserId?: string | null
  }

  const brand = body.brand as Brand
  const mechanic = body.mechanic as Mechanic

  if (brand !== "crossfriend" && brand !== "pranajiva") {
    res.status(400).json({ error: "Unknown brand." })
    return
  }
  if (!MECHANICS.includes(mechanic)) {
    res.status(400).json({ error: "Unknown mechanic." })
    return
  }

  /**
   * A note is required, in both directions.
   *
   * Every version here is permanent and the one it replaced is still readable beside it. The only
   * thing that ever explains the difference between them is a sentence somebody wrote at the time,
   * and it never gets written unless it is asked for at the moment it is true.
   */
  if (!body.note?.trim()) {
    res.status(400).json({ error: "A note is required, so the change explains itself later." })
    return
  }

  const proposal = {
    brand,
    pincode: body.pincode ?? null,
    mechanic,
    isEnabled: body.isEnabled === true,
    startsAt: body.startsAt ? new Date(body.startsAt) : null,
    endsAt: body.endsAt ? new Date(body.endsAt) : null,
    maxGrants: body.maxGrants ?? null,
    budgetPaise: body.budgetPaise ?? null,
    params: body.params ?? {},
    note: body.note.trim(),
    createdBy: body.opsUserId ?? null,
  }

  try {
    const guard = await checkProposal(proposal)
    if (guard.blocks.length) {
      res.status(422).json({ error: "Refused.", blocks: guard.blocks, warnings: guard.warnings })
      return
    }

    const saved = await putVersion(proposal)

    res.status(200).json({
      saved,
      warnings: guard.warnings,
      preview: guard.preview,
      history: await getHistory(brand, proposal.pincode, mechanic),
    })
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      res.status(422).json({ error: "Refused.", blocks: error.problems, warnings: [] })
      return
    }
    console.error("[ops/wallet/config] write failed", error)
    res.status(500).json({ error: "Could not save the reward configuration." })
  }
}
