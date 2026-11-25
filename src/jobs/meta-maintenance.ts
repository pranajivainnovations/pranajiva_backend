import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { isMissingSchema } from "../services/meta/db"
import { checkAccounts, purgeOld, rollupAnalytics } from "../services/meta/automation"

/**
 * Daily, for the Meta integrations:
 *   1. proves each connected account's token still works (system-user tokens do not expire, but can
 *      be revoked or unassigned — found here instead of by the first DM that never arrives);
 *   2. rolls yesterday and today into meta.analytics_daily, which outlives the detail rows;
 *   3. trims old detail: deliveries 14 days, execution logs 90, inbox and DM history 180.
 * Each step runs even if an earlier one failed.
 */
export default async function metaMaintenance({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      return await fn()
    } catch (error) {
      if (!isMissingSchema(error)) logger.error(`[meta] ${name} failed: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }
  const check = (await step("daily check", checkAccounts)) as { ok: number; failed: number } | null
  if (check?.failed) logger.warn(`[meta] daily check: ${check.ok} account(s) fine, ${check.failed} failing — see OPS`)
  await step("analytics rollup", rollupAnalytics)
  await step("purge", purgeOld)
}

export const config: ScheduledJobConfig = {
  name: "meta-maintenance",
  /* 03:50 UTC (9:20 AM IST), clear of the wallet and order sweeps. */
  schedule: "50 3 * * *",
  data: {},
}
