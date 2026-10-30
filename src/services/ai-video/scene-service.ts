import { composeScenePrompt } from "./compose-prompt"
import {
  downloadVideo,
  estimateCents,
  generateVideo,
  type AspectRatio,
  type ImagePart,
  type Resolution,
} from "./omni-provider"
import { ReelError, credentialForRender, spentThisMonthCents } from "./reel-service"
import { fetchAnchorImage, getSocialDbPool, putShotVideo } from "./store"
import { readMp4Duration } from "./reel-service"

/**
 * The storyboard: planning scenes, and rendering takes of them.
 *
 * ── Why planning and rendering are different calls ────────────────────────────────────────────
 * Because planning is free and rendering is not. An operator rearranges a storyboard, rewrites a
 * line, swaps a reference image and changes their mind about the camera a dozen times before
 * anything is worth paying for, and every one of those is a cheap write to a row. Pressing Render
 * is the single moment money moves, and keeping it a separate verb is what makes that moment
 * visible instead of incidental.
 *
 * ── Why a scene can be rendered more than once ────────────────────────────────────────────────
 * Because nobody keeps the first take. The old design had one row per position and a uniqueness
 * constraint that made a second attempt impossible, which is the wrong trade: the constraint was
 * there to stop a double-click charging twice, and it also stopped the normal way of working. Takes
 * are numbered within their scene, so a double-click still cannot produce two takes with the same
 * number, and a fourth attempt is just a fourth row.
 */

/* ── Planning ──────────────────────────────────────────────────────────────────────────────── */

export interface SceneInput {
  prompt?: string
  shotType?: string
  cameraMove?: string
  audioNote?: string
  avoid?: string
  targetSeconds?: number
  continuesFrom?: string | null
  imageKeys?: string[]
}

export async function addScene(reelId: string): Promise<{ sceneId: string; seq: number }> {
  const db = getSocialDbPool()

  const { rows: reels } = await db.query(`SELECT status FROM social.reels WHERE id = $1::uuid`, [reelId])
  if (!reels.length) throw new ReelError("not_found", "No such reel.", 404)
  if (reels[0].status !== "building") {
    throw new ReelError("closed", "That reel is finished. Start a new one to keep adding scenes.", 409)
  }

  /**
   * The position is derived inside the insert.
   *
   * A screen that sent `seq` would be sending a number it read a moment ago, and two operators —
   * or one impatient double-click — would send the same one. Derived here, the uniqueness
   * constraint has something real to defend.
   */
  const { rows } = await db.query(
    `INSERT INTO social.reel_scenes (reel_id, seq)
     SELECT $1::uuid, COALESCE(MAX(seq), 0) + 1 FROM social.reel_scenes WHERE reel_id = $1::uuid
     RETURNING id, seq`,
    [reelId]
  )

  return { sceneId: rows[0].id, seq: rows[0].seq }
}

export async function updateScene(sceneId: string, input: SceneInput): Promise<void> {
  const seconds = Number(input.targetSeconds ?? 5)
  if (!Number.isInteger(seconds) || seconds < 3 || seconds > 10) {
    throw new ReelError("bad_length", "A scene runs between 3 and 10 seconds — that is the model's own range.")
  }

  const images = (input.imageKeys ?? []).filter(Boolean).slice(0, 6)

  /**
   * A scene cannot continue from one that comes after it.
   *
   * Checked rather than assumed, because scenes can be reordered and a storyboard where scene 2
   * continues scene 5 is one that cannot be rendered in any order. The database guards against a
   * scene continuing itself; this guards the subtler version.
   */
  if (input.continuesFrom) {
    const { rows } = await getSocialDbPool().query(
      `SELECT a.seq AS this_seq, b.seq AS from_seq, a.reel_id = b.reel_id AS same_reel
         FROM social.reel_scenes a, social.reel_scenes b
        WHERE a.id = $1::uuid AND b.id = $2::uuid`,
      [sceneId, input.continuesFrom]
    )
    const row = rows[0]
    if (!row || !row.same_reel) {
      throw new ReelError("bad_reference", "A scene can only continue from another scene in the same reel.")
    }
    if (row.from_seq >= row.this_seq) {
      throw new ReelError(
        "bad_reference",
        `Scene ${row.this_seq} cannot continue from scene ${row.from_seq} — a continuation has to follow what it continues.`
      )
    }
  }

  await getSocialDbPool().query(
    `UPDATE social.reel_scenes
        SET prompt = $2, shot_type = $3, camera_move = $4, audio_note = $5, avoid = $6,
            target_seconds = $7, continues_from = $8, image_keys = $9::text[], updated_at = NOW()
      WHERE id = $1::uuid`,
    [
      sceneId,
      String(input.prompt ?? "").slice(0, 4000),
      String(input.shotType ?? "").slice(0, 48),
      String(input.cameraMove ?? "").slice(0, 48),
      String(input.audioNote ?? "").slice(0, 1000),
      String(input.avoid ?? "").slice(0, 1000),
      seconds,
      input.continuesFrom || null,
      images,
    ]
  )
}

/**
 * Removes a scene and renumbers what follows it.
 *
 * Renumbering in the same transaction, because the gap left by a deleted scene is not cosmetic:
 * positions are what the storyboard reads in order and what a continuation is validated against.
 * Takes go with it by cascade — their videos stay in S3, which is deliberate, since bytes already
 * paid for should not disappear because a plan changed.
 */
export async function deleteScene(sceneId: string): Promise<void> {
  const db = getSocialDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    const { rows } = await client.query(
      `DELETE FROM social.reel_scenes WHERE id = $1::uuid RETURNING reel_id, seq`,
      [sceneId]
    )
    if (rows.length) {
      await client.query(
        `UPDATE social.reel_scenes SET seq = seq - 1, updated_at = NOW()
          WHERE reel_id = $1::uuid AND seq > $2`,
        [rows[0].reel_id, rows[0].seq]
      )
    }

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Swaps a scene with its neighbour. Two statements under one transaction, via a position no row uses. */
export async function moveScene(sceneId: string, direction: "up" | "down"): Promise<void> {
  const db = getSocialDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    const { rows } = await client.query(
      `SELECT reel_id, seq FROM social.reel_scenes WHERE id = $1::uuid FOR UPDATE`,
      [sceneId]
    )
    if (!rows.length) throw new ReelError("not_found", "No such scene.", 404)

    const { reel_id: reelId, seq } = rows[0]
    const target = direction === "up" ? seq - 1 : seq + 1

    const { rows: neighbour } = await client.query(
      `SELECT id FROM social.reel_scenes WHERE reel_id = $1::uuid AND seq = $2 FOR UPDATE`,
      [reelId, target]
    )
    if (!neighbour.length) {
      /* Already at the end. Not an error — the button simply had nothing to do. */
      await client.query("COMMIT")
      return
    }

    /* Through 0, because (reel_id, seq) is unique and a direct swap would collide mid-statement. */
    await client.query(`UPDATE social.reel_scenes SET seq = 0 WHERE id = $1::uuid`, [sceneId])
    await client.query(`UPDATE social.reel_scenes SET seq = $2 WHERE id = $1::uuid`, [neighbour[0].id, seq])
    await client.query(`UPDATE social.reel_scenes SET seq = $2, updated_at = NOW() WHERE id = $1::uuid`, [
      sceneId,
      target,
    ])

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Which take of a scene is the keeper. */
export async function chooseTake(sceneId: string, takeId: string | null): Promise<void> {
  await getSocialDbPool().query(
    `UPDATE social.reel_scenes SET chosen_take_id = $2, updated_at = NOW() WHERE id = $1::uuid`,
    [sceneId, takeId]
  )
}

/* ── Rendering ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Renders one take of one scene.
 *
 * Returns as soon as the row exists. The generation call holds its connection open for minutes and
 * there is no operation to poll, so the work runs detached and the row is what the screen watches.
 */
export async function renderTake(input: {
  sceneId: string
  opsUserId: string
}): Promise<{ takeId: string; attempt: number }> {
  const db = getSocialDbPool()

  const { rows } = await db.query(
    `SELECT s.*, r.id AS reel_id, r.aspect_ratio, r.resolution, r.status AS reel_status
       FROM social.reel_scenes s JOIN social.reels r ON r.id = s.reel_id
      WHERE s.id = $1::uuid`,
    [input.sceneId]
  )
  const scene = rows[0]
  if (!scene) throw new ReelError("not_found", "No such scene.", 404)
  if (scene.reel_status !== "building") {
    throw new ReelError("closed", "That reel is finished.", 409)
  }
  if (!String(scene.prompt ?? "").trim()) {
    throw new ReelError("no_prompt", "Describe what happens in this scene before rendering it.")
  }

  const credential = await credentialForRender(input.opsUserId)

  const spent = await spentThisMonthCents(input.opsUserId)
  if (spent >= credential.monthlyCapCents) {
    throw new ReelError(
      "cap_reached",
      `You have used your $${(credential.monthlyCapCents / 100).toFixed(2)} monthly ceiling ` +
        `($${(spent / 100).toFixed(2)} spent). Raise it under Social → Settings to carry on.`,
      402
    )
  }

  /**
   * What this take continues from, resolved now rather than at planning time.
   *
   * The scene names another SCENE; the interaction id belongs to whichever take that scene settled
   * on. Resolved at render time so changing the chosen take of scene 2 changes what scene 3
   * continues from, which is what an operator picking a better take expects to happen.
   */
  let prevInteractionId: string | null = null
  if (scene.continues_from) {
    const { rows: source } = await db.query(
      `SELECT t.interaction_id, s.seq
         FROM social.reel_scenes s
         LEFT JOIN social.reel_takes t ON t.id = s.chosen_take_id
        WHERE s.id = $1::uuid`,
      [scene.continues_from]
    )
    const from = source[0]
    if (!from?.interaction_id) {
      throw new ReelError(
        "chain_broken",
        `Scene ${from?.seq ?? "?"} has no chosen take to continue from. Render it and pick a take first.`,
        409
      )
    }
    prevInteractionId = from.interaction_id
  }

  const imageKeys: string[] = scene.image_keys ?? []

  /* Mutually exclusive, and refused rather than resolved: one says "start here", the other says
     "carry on from there", and guessing which was meant costs money either way. */
  if (prevInteractionId && imageKeys.length) {
    throw new ReelError(
      "both_anchors",
      "A continuing scene cannot also carry reference images — it continues from the previous take's last frame. " +
        "Either clear the images, or clear what it continues from and keep the references.",
      400
    )
  }

  const composed = composeScenePrompt({
    prompt: scene.prompt,
    shotType: scene.shot_type,
    cameraMove: scene.camera_move,
    audioNote: scene.audio_note,
    avoid: scene.avoid,
    targetSeconds: scene.target_seconds,
    imageCount: imageKeys.length,
    isContinuation: Boolean(prevInteractionId),
  })

  const { rows: inserted } = await db.query(
    `INSERT INTO social.reel_takes
       (scene_id, attempt, composed_prompt, prev_interaction_id, created_by)
     SELECT $1::uuid, COALESCE(MAX(attempt), 0) + 1, $2, $3, $4::uuid
       FROM social.reel_takes WHERE scene_id = $1::uuid
     RETURNING id, attempt`,
    [input.sceneId, composed, prevInteractionId, input.opsUserId]
  )

  const take = inserted[0]

  void runTake({
    takeId: take.id,
    reelId: scene.reel_id,
    seq: scene.seq,
    attempt: take.attempt,
    composed,
    imageKeys,
    prevInteractionId,
    aspectRatio: scene.aspect_ratio as AspectRatio,
    resolution: scene.resolution as Resolution,
    apiKey: credential.apiKey,
    model: credential.model,
    continuesFrom: scene.continues_from,
  }).catch((error) => {
    console.error(`[social] take ${take.id} crashed outside its own handler: ${String(error)}`)
  })

  return { takeId: take.id, attempt: take.attempt }
}

/** Does the work and records the outcome. Never throws — there is nobody to catch it. */
async function runTake(input: {
  takeId: string
  reelId: string
  seq: number
  attempt: number
  composed: string
  imageKeys: string[]
  prevInteractionId: string | null
  aspectRatio: AspectRatio
  resolution: Resolution
  apiKey: string
  model: string
  continuesFrom: string | null
}): Promise<void> {
  const db = getSocialDbPool()

  const fail = async (message: string, raw?: string) => {
    await db
      .query(
        `UPDATE social.reel_takes SET status = 'failed', error = $2, finished_at = NOW()
          WHERE id = $1::uuid`,
        [input.takeId, [message, raw].filter(Boolean).join(" — ").slice(0, 2000)]
      )
      .catch(() => {})
  }

  try {
    const images: ImagePart[] = []
    for (const key of input.imageKeys) {
      const anchor = await fetchAnchorImage(key)
      if (!anchor) return void (await fail(`A reference image could not be read back from storage (${key}).`))
      images.push(anchor)
    }

    const result = await generateVideo({
      apiKey: input.apiKey,
      model: input.model,
      prompt: input.composed,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      images: input.prevInteractionId ? undefined : images,
      previousInteractionId: input.prevInteractionId ?? undefined,
    })

    /* Kept even on failure when Google gave one: it is the only handle on a render that may have
       been billed anyway. */
    if (result.interactionId) {
      await db
        .query(`UPDATE social.reel_takes SET interaction_id = $2 WHERE id = $1::uuid`, [
          input.takeId,
          result.interactionId,
        ])
        .catch(() => {})
    }

    if (!result.ok) return void (await fail(result.error ?? "The render failed.", result.raw))

    let bytes = result.inlineData
    if (!bytes && result.fileUri) {
      const download = await downloadVideo(result.fileUri, input.apiKey)
      if (!download.ok || !download.bytes) {
        return void (await fail(download.error ?? "The video was generated but could not be downloaded."))
      }
      bytes = download.bytes
    }
    if (!bytes) return void (await fail("Google returned neither video data nor a download URI."))

    const stored = await putShotVideo(input.reelId, input.seq * 100 + input.attempt, bytes)
    const seconds = readMp4Duration(bytes)
    const cents = seconds ? estimateCents(seconds) : null

    /**
     * Whether a continuation came back cumulative, inferred from length.
     *
     * Still undocumented, and still the thing that decides whether a finished reel needs stitching.
     * Compared against the take this one continued from rather than the previous scene in order,
     * because with a storyboard those are not always the same scene.
     */
    let cumulative: boolean | null = null
    if (input.prevInteractionId && seconds && input.continuesFrom) {
      const { rows } = await db.query(
        `SELECT t.seconds FROM social.reel_scenes s
           JOIN social.reel_takes t ON t.id = s.chosen_take_id
          WHERE s.id = $1::uuid`,
        [input.continuesFrom]
      )
      const previousSeconds = Number(rows[0]?.seconds ?? 0)
      if (previousSeconds > 0) cumulative = seconds > previousSeconds * 1.5
    }

    await db.query(
      `UPDATE social.reel_takes
          SET status = 'ready', video_key = $2, video_url = $3, seconds = $4,
              cost_cents = $5, cumulative = $6, error = NULL, finished_at = NOW()
        WHERE id = $1::uuid`,
      [input.takeId, stored.key, stored.url, seconds, cents, cumulative]
    )

    /**
     * The first successful take of a scene becomes its chosen one.
     *
     * So a storyboard rendered straight through is immediately coherent and a continuation has
     * something to follow, without an operator having to confirm each take before the next scene
     * can run. A later take never steals the selection — picking a different one stays a decision.
     */
    await db.query(
      `UPDATE social.reel_scenes SET chosen_take_id = $2, updated_at = NOW()
        WHERE id = (SELECT scene_id FROM social.reel_takes WHERE id = $2::uuid)
          AND chosen_take_id IS NULL`,
      [null, input.takeId]
    )
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error))
  }
}

/** Gives up on an orphaned render — a restart took the open fetch with it. */
export async function abandonTake(takeId: string): Promise<void> {
  await getSocialDbPool().query(
    `UPDATE social.reel_takes
        SET status = 'failed', finished_at = NOW(),
            error = COALESCE(error, 'Abandoned — the backend restarted while this was rendering. It may still have been billed.')
      WHERE id = $1::uuid AND status = 'rendering'`,
    [takeId]
  )
}
