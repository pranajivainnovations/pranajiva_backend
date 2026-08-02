/**
 * Shared Postgres pool for the `pricing` schema.
 *
 * Reuses Medusa's own DATABASE_URL — pricing lives in the same database as Medusa core,
 * baker_network, ai_studio, and research, just in its own namespace. Same pattern as
 * baker-network/db.ts.
 */

import { Pool } from "pg"

let pool: Pool | null = null

export function getPricingDbPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("[pricing] DATABASE_URL is not set")
  }

  pool = new Pool({ connectionString, max: 5 })
  return pool
}
