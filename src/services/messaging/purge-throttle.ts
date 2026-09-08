/**
 * Runs the attempt-log retention sweep at most once a day, without a scheduler.
 *
 * This project has no job runner, and introducing one for a single daily DELETE would be more
 * moving parts than the problem justifies. Instead the sweep rides along on the send path, guarded
 * by a Redis key so that only the first request of each day actually does the work.
 *
 * SET NX EX is what makes this safe across replicas: the key is claimed atomically, so if three
 * containers handle a send in the same second, exactly one of them purges. A plain "read the
 * timestamp, compare, write it back" would let all three through.
 *
 * If Redis is unavailable the sweep is skipped rather than run — a purge that is a day late is
 * harmless, and this must never be the thing that makes a sign-in fail.
 */

import { getMessagingRedis } from "./redis"
import { purgeExpiredAttempts } from "./otp-log"

const PURGE_LOCK_KEY = "cf:otp:purge-lock"
const ONCE_PER_SECONDS = 60 * 60 * 24

export async function maybePurgeAttemptLog(): Promise<void> {
  try {
    const redis = getMessagingRedis()
    const claimed = await redis.set(PURGE_LOCK_KEY, "1", "EX", ONCE_PER_SECONDS, "NX")
    if (claimed !== "OK") return
    await purgeExpiredAttempts()
  } catch (error) {
    console.error("[otp-log] purge throttle skipped", error)
  }
}
