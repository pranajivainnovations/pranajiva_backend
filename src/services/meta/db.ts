import { Pool } from "pg"

/**
 * Pool for the `meta` schema. Same database as Medusa, its own namespace — the pattern
 * baker-network/db.ts and ai-image/db.ts already use.
 */

let pool: Pool | null = null

export function metaDb(): Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[meta] DATABASE_URL is not set")
  pool = new Pool({ connectionString, max: 4 })
  return pool
}

/** Postgres "relation/schema does not exist" — the migration has not been applied yet. */
export function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  return code === "42P01" || code === "3F000"
}
