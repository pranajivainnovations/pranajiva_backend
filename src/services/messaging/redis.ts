/**
 * Shared ioredis connection for OTP storage and rate limiting.
 *
 * Separate from Medusa's cache and event-bus modules on purpose. Those are configured with
 * @medusajs/cache-redis, whose interface is get/set/invalidate — it has no INCR, no atomic
 * decrement, and no way to expire a counter. OTP attempt limiting needs all three, and a limiter
 * built on read-modify-write through the cache module would be defeated by two concurrent requests.
 *
 * Points at the same REDIS_URL as everything else, with a key namespace of its own so a `FLUSHDB`
 * of the Medusa cache never silently invalidates OTPs mid-login.
 */

import Redis from "ioredis"

let client: Redis | null = null

export function getMessagingRedis(): Redis {
  if (client) return client

  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error("[messaging] REDIS_URL is not set — OTP cannot be issued without it")
  }

  /**
   * maxRetriesPerRequest: 3 rather than the ioredis default of 20. An OTP request is in front of a
   * waiting customer, so failing in a few hundred milliseconds and telling them to try again beats
   * holding the request open while a dead Redis is retried twenty times.
   *
   * The error handler is not optional: an ioredis client with no 'error' listener raises an
   * unhandled 'error' event when the socket drops, which takes the Node process down. medusa-config
   * carries the same note for the same reason.
   */
  client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  })

  client.on("error", (err) => {
    console.error("[messaging] redis error", err?.message ?? err)
  })

  return client
}

/** Namespaced so these keys are identifiable in redis-cli and never collide with Medusa's cache. */
export const KEY = {
  otp: (flow: string, mobile: string) => `cf:otp:${flow}:${mobile}`,
  attempts: (flow: string, mobile: string) => `cf:otp:attempts:${flow}:${mobile}`,
  cooldown: (flow: string, mobile: string) => `cf:otp:cooldown:${flow}:${mobile}`,
  dailyCount: (flow: string, mobile: string, day: string) =>
    `cf:otp:daily:${flow}:${mobile}:${day}`,
}
