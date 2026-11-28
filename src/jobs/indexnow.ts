import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { isMissingSchema } from "../services/seo/db"
import { runIndexNow } from "../services/seo/indexnow"

/**
 * IndexNow: every 5 minutes, send the pages that are due (product changes wait out their settle
 * time; failures their backoff), and every 30 minutes compare each site's sitemap with the last
 * snapshot for new, changed and removed pages. Sites without an IndexNow key are skipped.
 * Everything is logged in seo.indexnow_submissions and shown in OPS → Search & AI → IndexNow.
 */
export default async function indexNow({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")
  try {
    const r = await runIndexNow()
    if (r?.sent) logger.info(`[indexnow] ${r.sent} page(s) submitted`)
  } catch (error) {
    if (!isMissingSchema(error)) logger.error(`[indexnow] ${error instanceof Error ? error.message : error}`)
  }
}

export const config: ScheduledJobConfig = {
  name: "indexnow",
  schedule: "*/5 * * * *",
  data: {},
}
