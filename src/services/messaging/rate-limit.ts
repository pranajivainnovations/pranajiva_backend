/**
 * Abuse limits for OTP sign-in, independent of who owns the code.
 *
 * Under SendOTP, MSG91 generates, stores and verifies the OTP — so the storage and comparison in
 * ./otp.ts are no longer needed. These limits still are, for reasons that survive the change:
 *
 *   1. MSG91's own throttles are undocumented, invisible to us, and not tunable per flow. We cannot
 *      report on what we cannot see, and we cannot loosen a limit for a legitimate burst.
 *   2. Every send and every verify is a billable call. Without a gate in front, anyone can point a
 *      script at the public endpoint and spend the account's balance.
 *   3. A verification cap on our side means a guessing attack is refused before it reaches MSG91,
 *      rather than relying on a provider behaviour nobody here has confirmed.
 *
 * Nothing in this file stores or derives an OTP. That is the whole distinction from ./otp.ts.
 */

import { getMessagingRedis, KEY } from "./redis"

/** IST day boundary — the daily cap should roll over at midnight where the customers are. */
function istDayKey(): string {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
  return nowIst.toISOString().slice(0, 10)
}

export interface ReserveResult {
  ok: boolean
  error?: string
  retryAfterSeconds?: number
}

export interface Limits {
  flowKey: string
  resendCooldownSeconds: number
  dailySendLimit: number
}

/**
 * Claims a send slot before the provider is called.
 *
 * Order matters: the cooldown is checked before the daily counter is incremented, so a customer
 * hammering the resend button burns cooldown rejections rather than their daily allowance.
 */
export async function reserveSend(limits: Limits, mobile: string): Promise<ReserveResult> {
  const redis = getMessagingRedis()
  const { flowKey } = limits

  const cooldownTtl = await redis.ttl(KEY.cooldown(flowKey, mobile))
  if (cooldownTtl > 0) {
    return {
      ok: false,
      error: `Please wait ${cooldownTtl}s before requesting another code.`,
      retryAfterSeconds: cooldownTtl,
    }
  }

  const dayKey = KEY.dailyCount(flowKey, mobile, istDayKey())
  const sentToday = await redis.incr(dayKey)
  if (sentToday === 1) {
    // 48h rather than 24h: the key is created at the first send of an IST day, and expiring it a
    // day later to the second would let a number roll over early by sending just before midnight.
    await redis.expire(dayKey, 60 * 60 * 48)
  }
  if (sentToday > limits.dailySendLimit) {
    return {
      ok: false,
      error: "Too many codes requested for this number today. Please try again tomorrow.",
    }
  }

  await redis.set(KEY.cooldown(flowKey, mobile), "1", "EX", limits.resendCooldownSeconds)
  return { ok: true }
}

/**
 * Releases a slot the customer never got value from.
 *
 * Called when the provider refused the message. Without it, a MSG91 outage would consume a number's
 * daily allowance and lock them out for the rest of the day over a failure that was not theirs.
 */
export async function releaseSend(limits: Limits, mobile: string): Promise<void> {
  const redis = getMessagingRedis()
  const { flowKey } = limits
  await redis
    .multi()
    .del(KEY.cooldown(limits.flowKey, mobile))
    .decr(KEY.dailyCount(flowKey, mobile, istDayKey()))
    .exec()
}

export interface AttemptResult {
  ok: boolean
  error?: string
}

/**
 * Counts one verification attempt and refuses once the budget is spent.
 *
 * The counter expires with the code's own lifetime, so a number that exhausted its attempts is not
 * locked out beyond the life of the code it was guessing at. It is checked BEFORE MSG91 is called,
 * which is the point — a guessing attack should be stopped here rather than forwarded to the
 * provider one billable request at a time.
 */
export async function countAttempt(
  flowKey: string,
  mobile: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<AttemptResult> {
  const redis = getMessagingRedis()
  const key = KEY.attempts(flowKey, mobile)

  const attempts = await redis.incr(key)
  if (attempts === 1) {
    await redis.expire(key, windowSeconds)
  }

  if (attempts > maxAttempts) {
    return { ok: false, error: "Too many incorrect attempts. Please request a new code." }
  }
  return { ok: true }
}

/** Clears the attempt budget once a code has been accepted. */
export async function clearAttempts(flowKey: string, mobile: string): Promise<void> {
  const redis = getMessagingRedis()
  await redis.del(KEY.attempts(flowKey, mobile))
}

/** How many attempts remain, for the message shown to the customer. Never negative. */
export async function attemptsRemaining(
  flowKey: string,
  mobile: string,
  maxAttempts: number
): Promise<number> {
  const redis = getMessagingRedis()
  const raw = await redis.get(KEY.attempts(flowKey, mobile))
  const used = Number(raw ?? 0)
  return Math.max(0, maxAttempts - used)
}
