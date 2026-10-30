import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Splitting a reel into a storyboard of scenes, and each scene into the takes attempted at it.
 *
 * ── What was wrong with one table ─────────────────────────────────────────────────────────────
 * `reel_shots` was both the plan and the render: one row per position, uniquely constrained so a
 * double-clicked Generate could not charge twice. That constraint did its job and also made the
 * thing operators actually need impossible — a second take. At roughly fifty cents an attempt
 * nobody keeps the first one, and "regenerate scene 3" meant destroying the only record of what
 * scene 3 had cost so far.
 *
 * So the plan and the attempts are separated. A scene is what you wrote; a take is what came back.
 * The money lives on the take, the intent lives on the scene, and `chosen_take_id` is which attempt
 * is the keeper. Nothing is overwritten and the cost of finding a good shot is visible rather than
 * discarded.
 *
 * ── Why a scene carries six image slots and not one ──────────────────────────────────────────
 * Because that is how the model keeps a character consistent across a cut. Reference images are
 * addressed from the prompt as IMAGE_REF_0 through IMAGE_REF_5, so a scene showing the same two
 * people in a new camera angle supplies their likenesses rather than hoping a continuation carried
 * them. A continuation preserves everything and allows nothing new; references allow a new angle
 * and preserve only what you supply. A 25-second reel needs both, scene by scene.
 *
 * ── Why target_seconds is on the scene but is not a duration ──────────────────────────────────
 * There is no duration parameter in this API — the model decides, between 3 and 10 seconds. What
 * the documentation does say is that timecodes in the prompt steer it. So this column is a hint
 * that gets composed INTO the prompt as a timecode, and the screen says so. Storing it as if it
 * were a setting, in a column called `duration`, would be the kind of lie that someone later
 * builds a total on.
 *
 * ── Why the composed prompt is stored on the take ─────────────────────────────────────────────
 * Because the prompt that was sent is not the prompt that was typed: the shot type, the camera
 * move, the audio note, the negatives and the timecode are all assembled into it. Six weeks later
 * the only honest answer to "why did this take look like that" is the text that actually went to
 * Google, so the take keeps its own copy and a later edit to the scene cannot rewrite history.
 */
export class ReelStoryboard1729100000000 implements MigrationInterface {
  name = "ReelStoryboard1729100000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Dropped rather than migrated.
     *
     * Checked before writing this: the table is empty, no render has ever been attempted and no
     * credential has ever been saved, so there is nothing to carry across. A migration that
     * transformed zero rows would be ceremony — but this is worth saying out loud, because the
     * same statement run against a table with takes in it would destroy a record of money spent.
     */
    await queryRunner.query(`DROP TABLE IF EXISTS social.reel_shots;`)

    await queryRunner.query(`
      CREATE TABLE social.reel_scenes (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reel_id         UUID         NOT NULL REFERENCES social.reels(id) ON DELETE CASCADE,
        seq             INTEGER      NOT NULL,

        /* What the operator wrote. Everything below is composed around it, never instead of it. */
        prompt          TEXT         NOT NULL DEFAULT '',

        /**
         * Cinematography, as separate fields rather than left to prose.
         *
         * The model responds to concrete terms — "eye-level medium shot", "slow push-in dolly" —
         * far better than to adjectives, and an operator writing freehand forgets to say them.
         * Held apart from the prompt so they can be changed without rewriting the sentence, and so
         * a whole reel can be checked for a consistent camera language at a glance.
         */
        shot_type       VARCHAR(48)  NOT NULL DEFAULT '',
        camera_move     VARCHAR(48)  NOT NULL DEFAULT '',

        /**
         * The model generates an audio track whether or not anybody asked it to, so silence has to
         * be requested. An empty value means the scene says nothing about audio and takes whatever
         * the model invents, which is rarely what anyone wanted.
         */
        audio_note      TEXT         NOT NULL DEFAULT '',

        /* There is no negative_prompt parameter; negatives are a sentence appended to the prompt. */
        avoid           TEXT         NOT NULL DEFAULT '',

        /* A hint, composed into the prompt as a timecode. See the note above on why not 'duration'. */
        target_seconds  INTEGER      NOT NULL DEFAULT 5,

        /**
         * Which scene this one continues from, or NULL for a scene that stands on its own.
         *
         * A reference to the scene rather than to a take, because the take it continues from is
         * whichever one that scene settled on — and that can change after this scene was planned.
         * Resolved to an interaction id at render time, not at planning time.
         */
        continues_from  UUID         REFERENCES social.reel_scenes(id) ON DELETE SET NULL,

        /* S3 keys. Position matters: index 0 is IMAGE_REF_0 in the prompt. */
        image_keys      TEXT[]       NOT NULL DEFAULT '{}',

        /* The take that is the keeper. Set when an operator picks one; NULL while deciding. */
        chosen_take_id  UUID,

        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT reel_scenes_seq_uniq   UNIQUE (reel_id, seq),
        CONSTRAINT reel_scenes_seq_ck     CHECK (seq >= 1),
        /* 3 to 10 is the model's own range for a single clip; asking outside it is asking for
           something it will not do. */
        CONSTRAINT reel_scenes_target_ck  CHECK (target_seconds BETWEEN 3 AND 10),
        /* Six is the documented limit on image references (IMAGE_REF_0 through IMAGE_REF_5). */
        CONSTRAINT reel_scenes_images_ck  CHECK (array_length(image_keys, 1) IS NULL
                                                OR array_length(image_keys, 1) <= 6),
        /* A scene cannot continue from itself, which a careless reorder could otherwise produce. */
        CONSTRAINT reel_scenes_self_ck    CHECK (continues_from IS DISTINCT FROM id)
      );
    `)

    await queryRunner.query(`
      CREATE INDEX reel_scenes_reel_idx ON social.reel_scenes (reel_id, seq);
    `)

    await queryRunner.query(`
      CREATE TABLE social.reel_takes (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scene_id            UUID         NOT NULL REFERENCES social.reel_scenes(id) ON DELETE CASCADE,

        /* 1, 2, 3 … within the scene. What makes "take 3 of scene 2" a thing you can say. */
        attempt             INTEGER      NOT NULL,

        /* Exactly what was sent. See the note above on why this is not derived on read. */
        composed_prompt     TEXT         NOT NULL,

        prev_interaction_id TEXT,
        interaction_id      TEXT,

        video_key           TEXT,
        video_url           TEXT,
        seconds             NUMERIC(5,2),
        cumulative          BOOLEAN,

        status              VARCHAR(16)  NOT NULL DEFAULT 'rendering',
        error               TEXT,
        cost_cents          INTEGER,

        created_by          UUID         REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        started_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        finished_at         TIMESTAMPTZ,

        CONSTRAINT reel_takes_status_ck  CHECK (status IN ('rendering', 'ready', 'failed')),
        /* The replacement for the old per-position uniqueness: a double-clicked Generate cannot
           produce two takes numbered the same, so it cannot charge twice. */
        CONSTRAINT reel_takes_attempt_uniq UNIQUE (scene_id, attempt),
        CONSTRAINT reel_takes_attempt_ck CHECK (attempt >= 1)
      );
    `)

    await queryRunner.query(`
      CREATE INDEX reel_takes_scene_idx ON social.reel_takes (scene_id, attempt DESC);
      CREATE INDEX reel_takes_rendering_idx ON social.reel_takes (started_at) WHERE status = 'rendering';
    `)

    /**
     * The chosen take has to belong to the scene that chose it.
     *
     * Added after both tables exist because it is circular. Without it a reorder or a bad write
     * could point a scene at another scene's take, and the reel would quietly assemble from a clip
     * nobody put in it — the sort of defect that is invisible until someone watches the output.
     */
    await queryRunner.query(`
      ALTER TABLE social.reel_scenes
        ADD CONSTRAINT reel_scenes_chosen_take_fkey
        FOREIGN KEY (chosen_take_id) REFERENCES social.reel_takes(id) ON DELETE SET NULL;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE social.reel_scenes DROP CONSTRAINT IF EXISTS reel_scenes_chosen_take_fkey;
    `)
    await queryRunner.query(`DROP TABLE IF EXISTS social.reel_takes;`)
    await queryRunner.query(`DROP TABLE IF EXISTS social.reel_scenes;`)
    /* reel_shots is deliberately not recreated: its schema was the thing this migration replaced,
       and an empty table in the old shape would only invite writing to it. */
  }
}
