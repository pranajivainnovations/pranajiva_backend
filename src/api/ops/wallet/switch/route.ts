import type { MedusaRequest, MedusaResponse } from "@medusajs/medusa"

import {
  isValidOpsServiceKey,
  OPS_SERVICE_KEY_HEADER,
} from "../../../../services/baker-portal/ops-service-auth"
import {
  areRewardsGloballyEnabled,
  getSwitchHistory,
  setSetting,
} from "../../../../services/wallet/settings"

const KEY = "rewards_globally_enabled"

/**
 * The global stop.
 *
 * GET  /ops/wallet/switch — is it on, and who last changed it
 * POST /ops/wallet/switch — turn it off or back on, with a reason
 *
 * ── Why this is not part of the config save path ───────────────────────────────────────────────
 * Because it has to work when that path does not. Saving a configuration resolves versions, merges
 * scopes and runs guardrails, any of which can be the reason somebody urgently needs to stop paying
 * out. This endpoint writes one row and reads none of that machinery.
 *
 * It is also why there is no validation to argue with here beyond requiring a reason: the whole
 * value of a stop is that nothing stands between deciding and its taking effect.
 *
 * ── Takes effect on the next order ─────────────────────────────────────────────────────────────
 * Nothing is cached. The evaluator reads this row before it reads anything else, so an order placed
 * a second after the flip is already covered. Credit already granted is untouched — stopping stops
 * issuing, it never revokes.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  try {
    const [enabled, history] = await Promise.all([
      areRewardsGloballyEnabled(),
      getSwitchHistory(KEY, 20),
    ])
    res.status(200).json({ enabled, history })
  } catch (error) {
    console.error("[ops/wallet/switch] read failed", error)
    res.status(500).json({ error: "Could not read the switch." })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!isValidOpsServiceKey(req.headers[OPS_SERVICE_KEY_HEADER] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized." })
    return
  }

  const body = (req.body ?? {}) as {
    enabled?: boolean
    reason?: string
    opsUserId?: string | null
  }

  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "Say whether rewards should be enabled: true or false." })
    return
  }

  /**
   * A reason is required in both directions.
   *
   * Turning rewards back on matters as much as turning them off — "we believe the fraud is dealt
   * with" is the sentence somebody will want to find later, and it is never written down unless it
   * is asked for at the moment it is true.
   */
  if (!body.reason?.trim()) {
    res.status(400).json({ error: "A reason is required, so the trail explains itself later." })
    return
  }

  try {
    const flip = await setSetting({
      key: KEY,
      value: body.enabled ? "true" : "false",
      reason: body.reason,
      actorOpsUserId: body.opsUserId ?? null,
    })

    console.warn(
      `[wallet] rewards ${body.enabled ? "RESUMED" : "STOPPED"} globally ` +
        `by ${body.opsUserId ?? "an unidentified operator"}: ${flip.reason}`
    )

    res.status(200).json({ enabled: body.enabled, flip })
  } catch (error) {
    console.error("[ops/wallet/switch] write failed", error)
    res.status(500).json({ error: "Could not change the switch." })
  }
}
