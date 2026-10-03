import { DeleteObjectCommand } from "@aws-sdk/client-s3"

import { getS3Client } from "../ai-image/s3-uploader"
import { getOrdersDbPool } from "../orders/db"

/**
 * Letting the team board forget.
 *
 * ── Why this needs a policy rather than a DELETE ───────────────────────────────────────────────
 * Three things make an age-based sweep wrong on this table, and each of them has to be answered
 * before a single row can go.
 *
 * Tasks are the same rows as messages. `is_task` turns a message into something somebody is meant
 * to do, and deleting by age alone would quietly bin an open task — the exact opposite of what the
 * board is for. So tasks are never purged by age; only a closed one, and only long after it closed.
 *
 * Rows are soft-deleted with `deleted_at` so that replies around them still make sense. A purge is
 * the one place a hard delete is correct, because the point is to stop paying for the row at all.
 *
 * A message can carry an image in S3 under the `board/` prefix. Deleting the row without the object
 * leaves the bucket growing invisibly — nothing would ever reference it again and nothing would ever
 * find it. So the object goes first, and the row only goes if that succeeded or the object was
 * already gone.
 *
 * ── Why the most recent messages are kept whatever their age ───────────────────────────────────
 * loadBoard reads the most recent 500 rows. A quiet team can have messages older than the retention
 * window that are still the newest thing on the board, and deleting those would empty a screen
 * somebody is looking at. Age decides what MAY go; the floor decides what stays regardless.
 */

/** Matches the hard limit loadBoard reads with, deliberately — see the header. */
const KEEP_RECENT = 500

const BOARD_PREFIX = "board/"

export interface PurgeResult {
  scanned: number
  messagesDeleted: number
  imagesDeleted: number
  imagesFailed: number
  skippedTasks: number
}

function bucket(): string {
  return process.env.S3_BUCKET || "pranajiva-innovations"
}

/**
 * The object key inside our bucket, or null if this is not our image.
 *
 * A link preview can point anywhere on the internet, and a board image could in principle be an
 * external URL somebody pasted. Returning null for anything that is not under our own board/ prefix
 * is what stops this trying to delete somebody else's picture.
 */
export function boardObjectKey(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null

  let path: string
  try {
    path = new URL(imageUrl).pathname
  } catch {
    /* Not a URL at all — a key stored directly is still ours if it is in the prefix. */
    path = String(imageUrl)
  }
  path = path.replace(/^\/+/, "")

  if (path.startsWith(BOARD_PREFIX)) return path

  /**
   * Path-style S3 puts the bucket in the path.
   *
   * Virtual-hosted URLs (bucket.s3.region.amazonaws.com/board/x.jpg) leave the key as the whole
   * path; path-style ones (s3.region.amazonaws.com/bucket/board/x.jpg) prefix it with the bucket.
   * Both forms are in use across this codebase's uploaders, and reading only the first silently
   * declined to delete every image stored through the second — the bucket would have grown exactly
   * as if this file did not exist.
   *
   * Only OUR bucket name is stripped, so a URL that happens to contain "board/" somewhere else
   * still returns null rather than becoming a delete against a key we do not own.
   */
  const withoutBucket = path.startsWith(`${bucket()}/`) ? path.slice(bucket().length + 1) : null
  return withoutBucket && withoutBucket.startsWith(BOARD_PREFIX) ? withoutBucket : null
}

/**
 * Remove board messages that nobody can reach any more.
 *
 * `olderThanDays` is measured from when a message was written, and for a closed task from when it
 * was closed — a task finished yesterday is recent work whatever date it was raised on.
 *
 * `dryRun` reports what would go without touching anything, which is how this should be run the
 * first time on a board with real history.
 */
export async function purgeOldBoardMessages(input: {
  olderThanDays?: number
  dryRun?: boolean
  limit?: number
  /**
   * How many of the newest messages are kept whatever their age.
   *
   * Defaults to what loadBoard reads. Exposed so the rule can be exercised without writing five
   * hundred rows to prove it, and so it can be lowered deliberately if the board ever gets a
   * search that makes deep scrollback unnecessary.
   */
  keepRecent?: number
} = {}): Promise<PurgeResult> {
  const days = input.olderThanDays ?? 365
  const keepRecent = Math.max(input.keepRecent ?? KEEP_RECENT, 0)
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000)
  const db = getOrdersDbPool()

  const result: PurgeResult = {
    scanned: 0,
    messagesDeleted: 0,
    imagesDeleted: 0,
    imagesFailed: 0,
    skippedTasks: 0,
  }

  /**
   * Everything outside the keep-recent floor that is old enough to go.
   *
   * The floor is computed as a row number over the whole table rather than as a date, because "the
   * most recent 500" is what the board shows and that is the thing being protected. An open task is
   * excluded here rather than filtered afterwards, so it can never be counted toward the limit and
   * crowd out a row that could actually have been removed.
   */
  const { rows: candidates } = await db.query(
    `WITH ranked AS (
       SELECT id, image_url, is_task, is_done, done_at, created_at,
              ROW_NUMBER() OVER (ORDER BY created_at DESC) AS recency
         FROM crossfriend.team_messages
     )
     SELECT id, image_url, is_task
       FROM ranked
      WHERE recency > $1
        AND (
          /* An ordinary message, old enough. */
          (NOT is_task AND created_at < NOW() - ($2 || ' days')::interval)
          /* Or a task that was finished, measured from when it was finished. */
          OR (is_task AND is_done AND COALESCE(done_at, created_at) < NOW() - ($2 || ' days')::interval)
        )
      ORDER BY created_at
      LIMIT $3`,
    [keepRecent, String(days), limit]
  )

  result.scanned = candidates.length

  /* Counted for the log: an open task is why a board stays large, and that is worth saying out loud
     rather than leaving somebody to wonder why the sweep found nothing. */
  const { rows: openTasks } = await db.query(
    `SELECT count(*)::int AS n FROM crossfriend.team_messages
      WHERE is_task AND NOT is_done AND created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  )
  result.skippedTasks = openTasks[0]?.n ?? 0

  if (input.dryRun) return result

  for (const row of candidates) {
    const key = boardObjectKey(row.image_url)

    /**
     * The object first, then the row.
     *
     * This order is the one that fails safely. An object deleted without its row leaves a broken
     * image on a message somebody can still see — visible, reportable, fixable. A row deleted
     * without its object leaves a file in the bucket that nothing references and nothing can find,
     * which is invisible and accumulates for ever. So a failed delete skips the row and tries again
     * on the next run.
     */
    if (key) {
      try {
        await getS3Client().send(
          new DeleteObjectCommand({ Bucket: bucket(), Key: key })
        )
        result.imagesDeleted += 1
      } catch (error) {
        result.imagesFailed += 1
        console.warn(
          `[board] could not delete ${key}, leaving its message in place: ` +
            `${error instanceof Error ? error.message : error}`
        )
        continue
      }
    }

    try {
      await db.query(`DELETE FROM crossfriend.team_messages WHERE id = $1`, [row.id])
      result.messagesDeleted += 1
    } catch (error) {
      console.error(
        `[board] could not delete message ${row.id}: ` +
          `${error instanceof Error ? error.message : error}`
      )
    }
  }

  return result
}
