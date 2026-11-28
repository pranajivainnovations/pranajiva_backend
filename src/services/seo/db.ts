import { Pool } from "pg"

/**
 * Pool for the `seo` schema (SEO Health Monitor). Same database as Medusa, its own namespace — the
 * pattern meta/db.ts and baker-network/db.ts use.
 */

let pool: Pool | null = null

export function seoDb(): Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[seo] DATABASE_URL is not set")
  pool = new Pool({ connectionString, max: 3 })
  return pool
}

/** Postgres "relation/schema does not exist" — the migration has not been applied yet. */
export function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  return code === "42P01" || code === "3F000"
}

export class SeoError extends Error {}
