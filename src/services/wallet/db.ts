/**
 * Shared Postgres pool for the `wallet` schema.
 *
 * Reuses Medusa's own DATABASE_URL — wallet lives in the same database as Medusa core, in its own
 * namespace, the same arrangement baker_network and ai_studio use. Its own module rather than
 * borrowing the baker-network pool because the two have nothing to do with each other, and a shared
 * name is how a connection limit raised for one silently becomes a limit on the other.
 */

import { Pool } from "pg"

let pool: Pool | null = null

export function getWalletDbPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("[wallet] DATABASE_URL is not set")
  }

  pool = new Pool({ connectionString, max: 5 })
  return pool
}
