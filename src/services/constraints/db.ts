/**
 * Shared Postgres pool for the `constraints` schema.
 *
 * Same database as Medusa core, baker_network, pricing, ai_studio, and research — just its own
 * connection pool and module, kept separate from `services/pricing/db.ts` so this domain never
 * imports anything out of the pricing service (constraints and pricing are independent features that
 * happen to share the same underlying attribute catalog, not one built on top of the other).
 */

import { Pool } from "pg"

let pool: Pool | null = null

export function getConstraintsDbPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("[constraints] DATABASE_URL is not set")
  }

  pool = new Pool({ connectionString, max: 5 })
  return pool
}
