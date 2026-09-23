/**
 * Shared Postgres pool for the `orders` schema.
 *
 * Reuses Medusa's own DATABASE_URL — orders lives in the same database as Medusa core, wallet,
 * pricing, ai_studio and baker_network, just in its own namespace. Its own module rather than
 * borrowing another schema's pool, for the same reason wallet has one: a shared name is how a
 * connection limit raised for one silently becomes a limit on the other.
 */

import { Pool } from "pg"

let pool: Pool | null = null

export function getOrdersDbPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("[orders] DATABASE_URL is not set")
  }

  pool = new Pool({ connectionString, max: 5 })
  return pool
}
