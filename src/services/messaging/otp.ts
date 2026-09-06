/**
 * Issue and verify one-time passwords.
 *
 * This replaces a mock that generated a code with Math.random, stored it nowhere, and accepted any
 * six digits on the way back in. Three properties are what make this real, and none of them are
 * optional:
 *
 *   1. The code is generated with crypto.randomInt, not Math.random. Math.random is seeded
 *      predictably and is not a CSPRNG — an attacker who observes a few codes can narrow the next.
 *   2. The code is stored server-side with a TTL, so verification has something to compare against.
 *   3. Attempts are counted and capped. A 6-digit code is one in a million, which falls in minutes
 *      to an unlimited guesser.
 */

import { createHmac, randomInt, timingSafeEqual } from "crypto"

import type { FlowConfig } from "./config"
import { getMessagingRedis, KEY } from "./redis"

/**
 * Codes are stored as an HMAC, never in plain text.
 *
 * Redis holds session data for the whole platform and is reachable by more processes than this one.
 * A 6-digit code has only a million preimages, so a bare SHA-256 of it would be reversible by
 * anyone holding the digest — the keyed HMAC is what makes the stored value useless without the
 * secret, which lives only in this process's environment.
 *
 * No fallback value on purpose. A hardcoded default secret is exactly the defect this codebase
 * already has in the storefront's OTP_PASSWORD_SALT, where the fallback shipped to production and
 * made every customer's password derivable from public source. Failing closed here is loud, and
 * loud is recoverable.
 */
export function isOtpSecretConfigured(): boolean {
  const secret = process.env.OTP_HASH_SECRET
  return Boolean(secret && secret.length >= 32)
}

function hashOtp(flowKey: string, mobile: string, code: string): Buffer {
  const secret = process.env.OTP_HASH_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      "[messaging] OTP_HASH_SECRET must be set to at least 32 characters before OTPs can be issued"
    )
  }
  // Flow and mobile are inside the HMAC so a digest captured for one number cannot be replayed
  // against another, even if an attacker can write to Redis.
  return createHmac("sha256", secret).update(`${flowKey}:${mobile}:${code}`).digest()
}

function generateCode(length: number): string {
  // randomInt is rejection-sampled and uniform; a modulo of a random buffer would not be.
  let code = ""
  for (let i = 0; i < length; i++) code += randomInt(0, 10).toString()
  return code
}

/** IST day boundary — the daily cap should roll over at midnight where the customers are. */
function istDayKey(): string {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
  return nowIst.toISOString().slice(0, 10)
}

/**
 * A flat interface rather than a discriminated union on `ok`.
 *
 * This project compiles without `strict`, and with strictNullChecks off TypeScript does not narrow
 * a union by a boolean discriminant — `if (!result.ok)` leaves both members in play and every
 * subsequent field access is an error. Callers still check `ok` before reading anything else; the
 * compiler simply cannot prove it under these settings.
 */
export interface IssueResult {
  ok: boolean
  code?: string
  expiresInSeconds?: number
  error?: string
  retryAfterSeconds?: number
}

/**
 * Reserves a send slot and returns the code to deliver.
 *
 * The rate limits are applied BEFORE the code is generated and stored, so a caller that is over its
 * limit never invalidates the OTP already sitting in Redis. Getting this order wrong turns the
 * resend button into a denial-of-service against the customer's own in-flight code.
 */
export async function issueOtp(
  config: FlowConfig,
  mobile: string
): Promise<IssueResult> {
  const redis = getMessagingRedis()
  const { flowKey } = config

  /**
   * Checked before anything is written, not at the point of hashing.
   *
   * hashOtp throws on a missing secret, and it is called after the daily counter has already been
   * incremented — so a misconfigured deployment would spend a customer's daily quota on every
   * attempt while never sending them anything. Failing here costs nothing.
   */
  if (!isOtpSecretConfigured()) {
    console.error("[messaging] OTP_HASH_SECRET is not set — refusing to issue a code")
    return { ok: false, error: "Sign-in is temporarily unavailable. Please try again later." }
  }

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
  if (sentToday > config.dailySendLimit) {
    return {
      ok: false,
      error: "Too many codes requested for this number today. Please try again tomorrow.",
    }
  }

  const code = generateCode(config.otpLength)

  const pipeline = redis.multi()
  pipeline.set(KEY.otp(flowKey, mobile), hashOtp(flowKey, mobile, code), "EX", config.otpTtlSeconds)
  // A fresh code gets a fresh attempt budget, expiring with the code so a stale counter cannot
  // lock out a number that has since been issued a new one.
  pipeline.set(KEY.attempts(flowKey, mobile), "0", "EX", config.otpTtlSeconds)
  pipeline.set(KEY.cooldown(flowKey, mobile), "1", "EX", config.resendCooldownSeconds)
  await pipeline.exec()

  return { ok: true, code, expiresInSeconds: config.otpTtlSeconds }
}

/** Undoes the reservation when the provider refused the message, so a failed send is not billed
 *  against the customer's daily cap or cooldown. The code is dropped too — it was never delivered,
 *  and leaving it live would let a resend collide with a code nobody has. */
export async function rollbackIssue(config: FlowConfig, mobile: string): Promise<void> {
  const redis = getMessagingRedis()
  const { flowKey } = config
  await redis
    .multi()
    .del(KEY.otp(flowKey, mobile))
    .del(KEY.attempts(flowKey, mobile))
    .del(KEY.cooldown(flowKey, mobile))
    .decr(KEY.dailyCount(flowKey, mobile, istDayKey()))
    .exec()
}

/** Flat for the same reason as IssueResult — see the note there. */
export interface VerifyResult {
  ok: boolean
  error?: string
}

/**
 * Checks a submitted code and consumes it.
 *
 * Consumption is unconditional on success: a code that has been accepted once is deleted, so the
 * same code cannot be replayed by anyone who observed it in transit or in a log.
 */
export async function verifyOtp(
  config: FlowConfig,
  mobile: string,
  submitted: string
): Promise<VerifyResult> {
  const redis = getMessagingRedis()
  const { flowKey } = config

  // Shape check first, so a malformed submission never costs the customer an attempt.
  if (!new RegExp(`^\\d{${config.otpLength}}$`).test(submitted)) {
    return { ok: false, error: `Enter the ${config.otpLength}-digit code sent to your mobile.` }
  }

  const stored = await redis.getBuffer(KEY.otp(flowKey, mobile))
  if (!stored) {
    return { ok: false, error: "That code has expired. Please request a new one." }
  }

  const attempts = await redis.incr(KEY.attempts(flowKey, mobile))
  if (attempts > config.maxAttempts) {
    // Burn the code rather than merely refusing this attempt. Leaving it alive after the budget is
    // spent would let an attacker wait for the counter to expire and resume guessing the same code.
    await redis.del(KEY.otp(flowKey, mobile))
    return { ok: false, error: "Too many incorrect attempts. Please request a new code." }
  }

  const expected = hashOtp(flowKey, mobile, submitted)
  // timingSafeEqual, not ===. String comparison short-circuits at the first differing byte, which
  // leaks how much of the digest matched; over enough requests that is enough to recover it.
  const matches = stored.length === expected.length && timingSafeEqual(stored, expected)

  if (!matches) {
    const remaining = Math.max(0, config.maxAttempts - attempts)
    return {
      ok: false,
      error: remaining
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
        : "Incorrect code. Please request a new one.",
    }
  }

  await redis
    .multi()
    .del(KEY.otp(flowKey, mobile))
    .del(KEY.attempts(flowKey, mobile))
    .exec()

  return { ok: true }
}
