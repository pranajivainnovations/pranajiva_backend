import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { isMissingSchema } from "../services/seo/db"
import { runAllSites } from "../services/seo/monitor"

/**
 * Daily SEO Health Monitor: checks every enabled site in seo.sites, one after another, and keeps
 * 90 days of history. Results are read in OPS → Search & AI.
 */
export default async function seoMonitor({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")
  try {
    const { started } = await runAllSites()
    logger.info(`[seo] daily check: ${started} site(s) checked`)
  } catch (error) {
    if (!isMissingSchema(error)) logger.error(`[seo] daily check failed: ${error instanceof Error ? error.message : error}`)
  }
}

export const config: ScheduledJobConfig = {
  name: "seo-monitor",
  /* 01:00 UTC = 6:30 AM IST, before the team starts and clear of the 9:20 AM Meta job. */
  schedule: "0 1 * * *",
  data: {},
}
