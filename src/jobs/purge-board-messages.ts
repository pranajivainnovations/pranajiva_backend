import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { purgeOldBoardMessages } from "../services/board/retention"

/**
 * Lets the team board forget what nobody can reach any more.
 *
 * ── Why a year, and why it is a floor rather than a target ─────────────────────────────────────
 * The board is where a small team says things to each other, and "what did we decide about that
 * supplier" is a question people ask months later. A year is long enough that anything still wanted
 * has been acted on, and the most recent 500 messages are kept whatever their age — so a quiet team
 * loses nothing at all.
 *
 * ── Why it runs weekly and not nightly ─────────────────────────────────────────────────────────
 * Nothing here is urgent. The cost of a message surviving six extra days is nil; the cost of a sweep
 * that deletes things is that somebody has to be able to notice it went wrong. Weekly keeps the log
 * readable, which is the only way anybody would spot it misbehaving.
 *
 * ── Why it is safe to run on a board that has none of this ─────────────────────────────────────
 * The table is empty today. The sweep finds nothing, logs nothing and costs one query a week —
 * which is the point of shipping it now rather than when the problem is already a full bucket.
 */
export default async function purgeBoardMessages({ container }: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")

  try {
    const result = await purgeOldBoardMessages({ olderThanDays: 365 })

    if (result.messagesDeleted > 0 || result.imagesFailed > 0) {
      logger.info(
        `[board] purged ${result.messagesDeleted} message(s) older than a year` +
          (result.imagesDeleted ? `, removed ${result.imagesDeleted} image(s)` : "") +
          (result.imagesFailed
            ? `, left ${result.imagesFailed} message(s) whose image could not be deleted`
            : "") +
          (result.skippedTasks ? `; ${result.skippedTasks} open task(s) kept regardless of age` : "")
      )
    }
  } catch (error) {
    /* Caught, never rethrown: an unhandled error in a scheduled job can take the worker down, and a
       dead worker means every later job is missed too. */
    logger.error(
      `[board] purge failed: ${error instanceof Error ? error.message : error}`
    )
  }
}

export const config: ScheduledJobConfig = {
  name: "purge-board-messages",
  /* Sunday 04:20, away from the hourly wallet and order sweeps. */
  schedule: "20 4 * * 0",
  data: {},
}
