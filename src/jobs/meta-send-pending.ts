import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { isMissingSchema } from "../services/meta/db"
import { drain } from "../services/meta/automation"

/**
 * Finishes whatever the webhook's own attempt did not: AI readings still waiting (Claude slow or
 * down) and DMs/replies Meta throttled, or that a restart interrupted.
 *
 * Every minute because a person who just commented "CALENDAR" is looking at their phone now.
 * With nothing waiting this is two indexed queries.
 */
export default async function metaSendPending({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")
  try {
    const { triaged, sent } = await drain()
    if (triaged || sent) logger.info(`[meta] queue: ${triaged} comment(s) read, ${sent} send(s) attempted`)
  } catch (error) {
    if (isMissingSchema(error)) return /* not migrated yet — nothing to do */
    logger.error(`[meta] queue failed: ${error instanceof Error ? error.message : error}`)
  }
}

export const config: ScheduledJobConfig = {
  name: "meta-send-pending",
  schedule: "* * * * *",
  data: {},
}
