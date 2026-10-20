import { keyFingerprint, openSecret, sealSecret } from "./secret-box"
import {
  downloadVideo,
  estimateCents,
  generateVideo,
  type AspectRatio,
  type ImagePart,
  type Resolution,
} from "./omni-provider"
import { fetchAnchorImage, getSocialDbPool, putShotVideo } from "./store"

/**
 * Building a reel, one continuation at a time.
 *
 * ── Why a shot renders detached ───────────────────────────────────────────────────────────────
 * A generation call holds its HTTP connection open for minutes — there is no operation to poll,
 * the result comes back on the request. Awaiting that inside an OPS button press would mean a
 * request sitting open past every proxy timeout between the browser and here, so `startShot`
 * records the row, launches the work, and returns immediately. The row is the state; the screen
 * watches the row.
 *
 * ── What that costs us, said plainly ──────────────────────────────────────────────────────────
 * The open fetch lives in this process. A backend restart mid-render loses it, and because the
 * interaction id only arrives WITH the result, a shot killed that way cannot be recovered — it is
 * marked failed and the money is gone. That is a real limitation rather than an oversight: the
 * alternative is a job queue and a worker, which is a lot of machinery to add before anybody has
 * made a second reel. `staleRenders` is how a screen finds the orphans.
 *
 * ── Why the cap is checked before every shot and not once ─────────────────────────────────────
 * Because the thing being guarded is a chain. Five shots at ten cents a second is most of a
 * finished reel's cost, and a cap tested only when the reel was created would let a chain started
 * under the limit run far past it. Checked per shot, the worst overrun is one shot.
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
 * Our own record of what we charged their key, not a figure from Google. It cannot see spending
 * they did elsewhere with the same key, which is why the screen calls it "spent here" — a cap that
 * claimed to know their whole bill would be lying.
 */
async function spentThisMonthCents(opsUserId: string): Promise<number> {
  const { rows } = await getSocialDbPool().query(
    `SELECT COALESCE(SUM(cost_cents), 0)::int AS spent
       FROM social.reel_shots
      WHERE created_by = $1::uuid
        AND status = 'ready'
        AND created_at >= date_trunc('month', NOW())`,
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

/** The decrypted key, which exists only inside this process and only for the length of a call. */
async function credentialFor(
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

/**
 * Queues the next shot and starts rendering it.
 *
 * ── Why the position is chosen here and not by the caller ─────────────────────────────────────
 * A screen that sent `seq` would be sending a number it read a moment ago, and two operators — or
 * one double-click — would send the same one. The position is derived inside the same statement
 * that inserts it, so the unique constraint on (reel_id, seq) has something real to defend.
 */
export async function startShot(input: {
  reelId: string
  prompt: string
  mode: "text" | "image" | "first_last" | "continue"
  firstImageKey?: string | null
  lastImageKey?: string | null
  opsUserId: string
}): Promise<{ shotId: string; seq: number }> {
  const db = getSocialDbPool()
  const prompt = input.prompt.trim()

  if (!prompt) throw new ReelError("no_prompt", "Describe what should happen in this shot.")

  const credential = await credentialFor(input.opsUserId)

  const spent = await spentThisMonthCents(input.opsUserId)
  if (spent >= credential.monthlyCapCents) {
    throw new ReelError(
      "cap_reached",
      `You have used your $${(credential.monthlyCapCents / 100).toFixed(2)} monthly ceiling ` +
        `($${(spent / 100).toFixed(2)} spent). Raise it under Social → Settings to carry on.`,
      402
    )
  }

  const { rows: reels } = await db.query(
    `SELECT id, aspect_ratio, resolution, status FROM social.reels WHERE id = $1::uuid`,
    [input.reelId]
  )
  const reel = reels[0]
  if (!reel) throw new ReelError("not_found", "No such reel.", 404)
  if (reel.status !== "building") {
    throw new ReelError("closed", "That reel is finished. Start a new one to keep generating.", 409)
  }

  /**
   * What this shot continues from.
   *
   * The last READY shot, not the last row: a failed attempt has no interaction id and continuing
   * from a still-rendering one is impossible, since the id does not exist until it finishes.
   */
  const { rows: previous } = await db.query(
    `SELECT seq, interaction_id, status
       FROM social.reel_shots WHERE reel_id = $1::uuid ORDER BY seq DESC LIMIT 1`,
    [input.reelId]
  )
  const last = previous[0]

  if (last?.status === "rendering") {
    throw new ReelError(
      "busy",
      `Shot ${last.seq} is still rendering. A continuation has to start from a finished clip.`,
      409
    )
  }

  if (input.mode === "continue") {
    if (!last) {
      throw new ReelError("nothing_to_continue", "Generate an opening shot before continuing from one.")
    }
    if (!last.interaction_id) {
      throw new ReelError(
        "chain_broken",
        `Shot ${last.seq} cannot be continued from — Google did not return a reference for it. ` +
          "Regenerate that shot, or start a fresh chain with an anchor image.",
        409
      )
    }
  }

  const seq = (last?.seq ?? 0) + 1

  const { rows: inserted } = await db.query(
    `INSERT INTO social.reel_shots
       (reel_id, seq, mode, prompt, first_image_key, last_image_key,
        prev_interaction_id, status, created_by, started_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'rendering', $8::uuid, NOW())
     RETURNING id`,
    [
      input.reelId,
      seq,
      input.mode,
      prompt,
      input.firstImageKey ?? null,
      input.lastImageKey ?? null,
      input.mode === "continue" ? last.interaction_id : null,
      input.opsUserId,
    ]
  )

  const shotId = inserted[0].id as string

  /* Detached: see the note at the top of the file. The row is already `rendering`, so the screen
     has something true to show the moment this returns. */
  void renderShot({
    shotId,
    reelId: input.reelId,
    seq,
    prompt,
    mode: input.mode,
    firstImageKey: input.firstImageKey ?? null,
    lastImageKey: input.lastImageKey ?? null,
    previousInteractionId: input.mode === "continue" ? last.interaction_id : undefined,
    aspectRatio: reel.aspect_ratio as AspectRatio,
    resolution: reel.resolution as Resolution,
    apiKey: credential.apiKey,
    model: credential.model,
  }).catch((error) => {
    console.error(`[social] shot ${shotId} crashed outside its own handler: ${String(error)}`)
  })

  return { shotId, seq }
}

/** Does the work and writes the outcome. Never throws — a thrown error here has nobody to catch it. */
async function renderShot(input: {
  shotId: string
  reelId: string
  seq: number
  prompt: string
  mode: string
  firstImageKey: string | null
  lastImageKey: string | null
  previousInteractionId?: string
  aspectRatio: AspectRatio
  resolution: Resolution
  apiKey: string
  model: string
}): Promise<void> {
  const db = getSocialDbPool()

  const fail = async (message: string, raw?: string) => {
    await db
      .query(
        `UPDATE social.reel_shots SET status = 'failed', error = $2, finished_at = NOW()
          WHERE id = $1::uuid`,
        [input.shotId, [message, raw].filter(Boolean).join(" — ").slice(0, 2000)]
      )
      .catch(() => {})
  }

  try {
    const images: ImagePart[] = []
    for (const key of [input.firstImageKey, input.lastImageKey]) {
      if (!key) continue
      const anchor = await fetchAnchorImage(key)
      if (!anchor) return void (await fail(`The anchor image could not be read back from storage (${key}).`))
      images.push(anchor)
    }

    const result = await generateVideo({
      apiKey: input.apiKey,
      model: input.model,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      images: input.previousInteractionId ? undefined : images,
      previousInteractionId: input.previousInteractionId,
    })

    if (!result.ok) {
      /* The interaction id is saved even on failure when Google gave one — it is the only handle on
         a render that may still have been billed. */
      if (result.interactionId) {
        await db
          .query(`UPDATE social.reel_shots SET interaction_id = $2 WHERE id = $1::uuid`, [
            input.shotId,
            result.interactionId,
          ])
          .catch(() => {})
      }
      return void (await fail(result.error ?? "The render failed.", result.raw))
    }

    let bytes = result.inlineData
    if (!bytes && result.fileUri) {
      const download = await downloadVideo(result.fileUri, input.apiKey)
      if (!download.ok || !download.bytes) {
        /* Rendered and billed, but not retrieved. Recorded with the interaction id so it can be
           continued from anyway — the chain does not need our copy of the bytes. */
        await db
          .query(`UPDATE social.reel_shots SET interaction_id = $2 WHERE id = $1::uuid`, [
            input.shotId,
            result.interactionId ?? null,
          ])
          .catch(() => {})
        return void (await fail(download.error ?? "The video was generated but could not be downloaded."))
      }
      bytes = download.bytes
    }

    if (!bytes) return void (await fail("Google returned neither video data nor a download URI."))

    const stored = await putShotVideo(input.reelId, input.seq, bytes)

    /**
     * Duration, measured rather than assumed.
     *
     * There is no duration parameter and the response does not state one, so this is read from the
     * MP4 itself. It is what the cost is computed from and what the reel's running total adds up,
     * which is why it is worth doing properly instead of assuming the 5 seconds a caller asked for
     * and could not actually request.
     */
    const seconds = readMp4Duration(bytes)
    const cents = seconds ? estimateCents(seconds) : null

    /**
     * Whether the extension came back cumulative.
     *
     * Undocumented, so it is inferred from length: a continuation materially longer than the clip
     * it continued tells us Google returned the whole thing, and a finished reel then needs no
     * stitching at all. Left NULL when there is nothing to compare against.
     */
    let cumulative: boolean | null = null
    if (input.previousInteractionId && seconds) {
      const { rows } = await db.query(
        `SELECT seconds FROM social.reel_shots
          WHERE reel_id = $1::uuid AND seq = $2 AND status = 'ready'`,
        [input.reelId, input.seq - 1]
      )
      const previousSeconds = Number(rows[0]?.seconds ?? 0)
      if (previousSeconds > 0) cumulative = seconds > previousSeconds * 1.5
    }

    await db.query(
      `UPDATE social.reel_shots
          SET status = 'ready', interaction_id = $2, video_key = $3, video_url = $4,
              seconds = $5, cost_cents = $6, cumulative = $7, error = NULL, finished_at = NOW()
        WHERE id = $1::uuid`,
      [
        input.shotId,
        result.interactionId ?? null,
        stored.key,
        stored.url,
        seconds,
        cents,
        cumulative,
      ]
    )
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Reads a duration out of an MP4's `mvhd` atom.
 *
 * Hand-rolled rather than shelling out, because the alternative is ffprobe and ffmpeg is not in
 * this image — adding a 70MB binary to read one number would be the wrong trade. `mvhd` carries a
 * timescale and a duration in the first few hundred bytes of every MP4 Google produces, and both
 * version 0 (32-bit) and version 1 (64-bit) layouts are handled because which one appears is the
 * encoder's choice, not ours.
 *
 * Returns null rather than guessing when the atom is not found. A null duration shows as unknown
 * on the screen and contributes nothing to the running total, which is the honest outcome — a
 * made-up five seconds would quietly corrupt every cost figure downstream.
 */
export function readMp4Duration(bytes: Buffer): number | null {
  const marker = bytes.indexOf("mvhd", 0, "ascii")
  if (marker < 0) return null

  try {
    const version = bytes.readUInt8(marker + 4)

    if (version === 1) {
      const timescale = bytes.readUInt32BE(marker + 8 + 16)
      /* 64-bit, read as two halves: Node has readBigUInt64BE, but the high word is always zero for
         any real video and this keeps the arithmetic in Number. */
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

/**
 * Renders that have been going too long to still be going.
 *
 * A generation takes minutes, never twenty of them, so anything past that threshold is almost
 * certainly a process restart that took the open fetch with it. Reported rather than cleaned up
 * automatically: the shot may have been billed, and quietly deleting the evidence of money spent
 * is not this function's decision to make.
 */
export async function staleRenders(olderThanMinutes = 20): Promise<
  { shotId: string; reelId: string; reelTitle: string; seq: number; startedAt: string }[]
> {
  const { rows } = await getSocialDbPool().query(
    `SELECT s.id, s.reel_id, r.title, s.seq, s.started_at
       FROM social.reel_shots s
       JOIN social.reels r ON r.id = s.reel_id
      WHERE s.status = 'rendering'
        AND s.started_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY s.started_at`,
    [String(olderThanMinutes)]
  )

  return rows.map((r) => ({
    shotId: r.id,
    reelId: r.reel_id,
    reelTitle: r.title,
    seq: r.seq,
    startedAt: r.started_at,
  }))
}

/** Gives up on an orphaned render, with the reason recorded rather than invented. */
export async function abandonShot(shotId: string): Promise<void> {
  await getSocialDbPool().query(
    `UPDATE social.reel_shots
        SET status = 'failed', finished_at = NOW(),
            error = COALESCE(error, 'Abandoned — the backend restarted while this was rendering. It may still have been billed.')
      WHERE id = $1::uuid AND status = 'rendering'`,
    [shotId]
  )
}

/** Closes a reel so no further shots can be added to it. */
export async function closeReel(reelId: string, status: "done" | "abandoned"): Promise<void> {
  await getSocialDbPool().query(
    `UPDATE social.reels SET status = $2, updated_at = NOW() WHERE id = $1::uuid`,
    [reelId, status]
  )
}
