import { keyFingerprint, openSecret, sealSecret } from "./secret-box"
import type { AspectRatio, Resolution } from "./omni-provider"
import { getSocialDbPool } from "./store"

/**
 * Reels, and the per-operator keys that pay for them.
 *
 * Planning scenes and rendering takes live in scene-service; what is here is everything that is
 * true of a reel as a whole — its existence, its framing, and whose money is behind it.
 *
 * ── Why the key is per operator ───────────────────────────────────────────────────────────────
 * A Gemini Pro subscription does not include API access, so video is billed per call on a separate
 * account. Whoever is making reels is the one paying, and a single shared key would mean one
 * person's card funding everybody's experiments with no way to see whose render spent what.
 */

export class ReelError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = "ReelError"
  }
}

/* ── Credentials ───────────────────────────────────────────────────────────────────────────── */

export interface CredentialSummary {
  provider: string
  model: string
  keyLast4: string
  monthlyCapCents: number
  spentThisMonthCents: number
}

export async function saveCredential(input: {
  opsUserId: string
  apiKey: string
  model: string
  monthlyCapCents: number
}): Promise<void> {
  const apiKey = input.apiKey.trim()
  if (apiKey.length < 20) {
    throw new ReelError("bad_key", "That does not look like a Gemini API key.", 400)
  }

  await getSocialDbPool().query(
    `INSERT INTO social.video_credentials
       (ops_user_id, provider, model, key_ciphertext, key_last4, monthly_cap_cents)
     VALUES ($1::uuid, 'gemini', $2, $3, $4, $5)
     ON CONFLICT (ops_user_id) DO UPDATE
       SET model = EXCLUDED.model,
           key_ciphertext = EXCLUDED.key_ciphertext,
           key_last4 = EXCLUDED.key_last4,
           monthly_cap_cents = EXCLUDED.monthly_cap_cents,
           updated_at = NOW()`,
    [input.opsUserId, input.model, sealSecret(apiKey), keyFingerprint(apiKey), input.monthlyCapCents]
  )
}

export async function deleteCredential(opsUserId: string): Promise<void> {
  await getSocialDbPool().query(`DELETE FROM social.video_credentials WHERE ops_user_id = $1::uuid`, [
    opsUserId,
  ])
}

/**
 * What this person has spent through the tool this month.
 *
 * Our own record of what we charged their key, not a figure from Google — it cannot see spending
 * they did elsewhere with the same key, which is why the screen calls it "spent here". Counted
 * across takes rather than scenes, because a scene rendered four times cost four times.
 */
export async function spentThisMonthCents(opsUserId: string): Promise<number> {
  const { rows } = await getSocialDbPool().query(
    `SELECT COALESCE(SUM(cost_cents), 0)::int AS spent
       FROM social.reel_takes
      WHERE created_by = $1::uuid
        AND status = 'ready'
        AND started_at >= date_trunc('month', NOW())`,
    [opsUserId]
  )
  return rows[0]?.spent ?? 0
}

export async function getCredentialSummary(opsUserId: string): Promise<CredentialSummary | null> {
  const { rows } = await getSocialDbPool().query(
    `SELECT provider, model, key_last4, monthly_cap_cents
       FROM social.video_credentials WHERE ops_user_id = $1::uuid`,
    [opsUserId]
  )
  const row = rows[0]
  if (!row) return null

  return {
    provider: row.provider,
    model: row.model,
    keyLast4: row.key_last4,
    monthlyCapCents: row.monthly_cap_cents,
    spentThisMonthCents: await spentThisMonthCents(opsUserId),
  }
}

/**
 * The decrypted key, which exists only inside this process and only for the length of a render.
 *
 * Named for what it is for. Nothing else in the codebase should reach for this — a second caller
 * would be a second place a plaintext key can be observed.
 */
export async function credentialForRender(
  opsUserId: string
): Promise<{ apiKey: string; model: string; monthlyCapCents: number }> {
  const { rows } = await getSocialDbPool().query(
    `SELECT model, key_ciphertext, monthly_cap_cents
       FROM social.video_credentials WHERE ops_user_id = $1::uuid`,
    [opsUserId]
  )
  const row = rows[0]
  if (!row) {
    throw new ReelError(
      "no_key",
      "Add your Gemini API key under Social → Settings first. Renders are billed to your own key.",
      400
    )
  }

  return { apiKey: openSecret(row.key_ciphertext), model: row.model, monthlyCapCents: row.monthly_cap_cents }
}

/* ── Reels ─────────────────────────────────────────────────────────────────────────────────── */

export async function createReel(input: {
  title: string
  brand: string
  aspectRatio: AspectRatio
  resolution: Resolution
  targetSeconds: number
  opsUserId: string
}): Promise<{ id: string }> {
  const title = input.title.trim()
  if (!title) throw new ReelError("no_title", "Give the reel a name so it can be found later.")

  const { rows } = await getSocialDbPool().query(
    `INSERT INTO social.reels (title, brand, aspect_ratio, resolution, target_seconds, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::uuid) RETURNING id`,
    [title, input.brand, input.aspectRatio, input.resolution, input.targetSeconds, input.opsUserId]
  )

  return { id: rows[0].id }
}

export async function closeReel(reelId: string, status: "done" | "abandoned"): Promise<void> {
  await getSocialDbPool().query(
    `UPDATE social.reels SET status = $2, updated_at = NOW() WHERE id = $1::uuid`,
    [reelId, status]
  )
}

/**
 * Renders that have been going too long to still be going.
 *
 * A generation takes minutes, never twenty of them, so anything past that is almost certainly a
 * process restart that took the open fetch with it. Reported rather than cleaned up automatically:
 * the take may have been billed, and quietly deleting the evidence of money spent is not this
 * function's decision to make.
 */
export async function staleRenders(olderThanMinutes = 20): Promise<
  { takeId: string; reelId: string; reelTitle: string; seq: number; attempt: number; startedAt: string }[]
> {
  const { rows } = await getSocialDbPool().query(
    `SELECT t.id, r.id AS reel_id, r.title, s.seq, t.attempt, t.started_at
       FROM social.reel_takes t
       JOIN social.reel_scenes s ON s.id = t.scene_id
       JOIN social.reels r ON r.id = s.reel_id
      WHERE t.status = 'rendering'
        AND t.started_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY t.started_at`,
    [String(olderThanMinutes)]
  )

  return rows.map((r) => ({
    takeId: r.id,
    reelId: r.reel_id,
    reelTitle: r.title,
    seq: r.seq,
    attempt: r.attempt,
    startedAt: r.started_at,
  }))
}

/**
 * Reads a duration out of an MP4's `mvhd` atom.
 *
 * Hand-rolled rather than shelling out, because the alternative is ffprobe and ffmpeg is not in
 * this image — adding a 70MB binary to read one number would be the wrong trade. Both the 32-bit
 * (version 0) and 64-bit (version 1) layouts are handled, because which one appears is the
 * encoder's choice rather than ours.
 *
 * Returns null rather than guessing when the atom is not found. A null duration shows as unknown
 * and contributes nothing to a total, which is the honest outcome — an invented five seconds would
 * quietly corrupt every cost figure downstream.
 */
export function readMp4Duration(bytes: Buffer): number | null {
  const marker = bytes.indexOf("mvhd", 0, "ascii")
  if (marker < 0) return null

  try {
    const version = bytes.readUInt8(marker + 4)

    if (version === 1) {
      const timescale = bytes.readUInt32BE(marker + 8 + 16)
      /* 64-bit read as two halves: the high word is zero for any real video and this keeps the
         arithmetic in Number. */
      const high = bytes.readUInt32BE(marker + 8 + 20)
      const low = bytes.readUInt32BE(marker + 8 + 24)
      const duration = high * 2 ** 32 + low
      return timescale > 0 ? Math.round((duration / timescale) * 100) / 100 : null
    }

    const timescale = bytes.readUInt32BE(marker + 8 + 8)
    const duration = bytes.readUInt32BE(marker + 8 + 12)
    return timescale > 0 ? Math.round((duration / timescale) * 100) / 100 : null
  } catch {
    return null
  }
}
