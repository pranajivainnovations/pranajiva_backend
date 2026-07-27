/**
 * Shared Postgres pool for the `ai_studio` schema.
 *
 * Reuses Medusa's own DATABASE_URL — the ai_studio schema lives in the same
 * database as Medusa core tables, just in its own namespace. Every
 * ai_studio.* query (generation, showcase, future credits/history) should
 * go through this single pool rather than opening its own connection.
 */

import { Pool } from "pg"

let pool: Pool | null = null

export function getAiStudioDbPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("[ai_studio] DATABASE_URL is not set")
  }

  pool = new Pool({ connectionString, max: 5 })
  return pool
}
