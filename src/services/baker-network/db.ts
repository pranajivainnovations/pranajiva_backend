/**
 * Shared Postgres pool for the `baker_network` schema.
 *
 * Reuses Medusa's own DATABASE_URL — baker_network lives in the same
 * database as Medusa core and ai_studio, just in its own namespace. Same
 * pattern as ai-image/db.ts.
 */

import { Pool } from "pg"

let pool: Pool | null = null

export function getBakerNetworkDbPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("[baker_network] DATABASE_URL is not set")
  }

  pool = new Pool({ connectionString, max: 5 })
  return pool
}
