import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Reels built as a chain of continuation shots, and the per-operator API keys that pay for them.
 *
 * ── Why the key is per operator and not in the environment ────────────────────────────────────
 * Every other credential in this system lives in the backend environment, because the business
 * owns it and spends from one account. Video generation is the first thing that is not like that:
 * a Gemini Pro subscription does not include API access, so the API is paid per call on a separate
 * billing account, and whoever is making reels is the one paying. A single shared key would mean
 * one person's card funding everybody's experiments, with no way to see whose render spent what.
 *
 * So the key belongs to the person, and this table is the only place in the codebase that stores a
 * credential. It is encrypted rather than hashed — unlike a password, we have to be able to read it
 * back to make the call — which makes it the one row here worth saying out loud is sensitive. The
 * ciphertext never leaves the backend, and `key_last4` exists so a screen can prove which key is
 * saved without ever being able to show it.
 *
 * ── Why a shot is a row and not a step in a function ──────────────────────────────────────────
 * Because a generation call takes minutes, costs real money, and cannot be replayed for free. A
 * reel is five or six of them chained, and the chain has to survive the operator closing the tab,
 * the backend restarting, and one shot failing in the middle. The row is the record of money spent
 * and the anchor for everything downstream: `interaction_id` is what the next shot continues FROM,
 * so losing it would mean the chain cannot be continued at all, only started again.
 *
 * ── Why `cumulative` is a column ──────────────────────────────────────────────────────────────
 * Google's own documentation does not say whether extending a video returns the new segment alone
 * or the whole clip so far, and the answer decides whether a finished reel needs stitching. Rather
 * than assume, each shot records what we actually observed, so the question is answered by data
 * from the first real render instead of by a guess that would be wrong half the time.
 */
export class CreateSocialVideo1729000000000 implements MigrationInterface {
  name = "CreateSocialVideo1729000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS social;`)

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS social.video_credentials (
        ops_user_id    UUID PRIMARY KEY REFERENCES baker_network.ops_users(id) ON DELETE CASCADE,
        provider       VARCHAR(32)  NOT NULL DEFAULT 'gemini',
        model          VARCHAR(64)  NOT NULL DEFAULT 'gemini-omni-1.1-flash',

        /* AES-256-GCM. See services/ai-video/secret-box.ts for why it is reversible. */
        key_ciphertext TEXT         NOT NULL,
        /* So a screen can say "…a7f3 is saved" without the key ever being readable. */
        key_last4      VARCHAR(8)   NOT NULL,

        /**
         * A ceiling, in US cents, on what this person's key may be charged through this tool in a
         * calendar month. Default is 2000 — twenty dollars, roughly eight finished reels at the
         * published rate. It exists because every other cost in this system is bounded by
         * something physical: an SMS costs paise, an image costs a fraction of a cent. A video is
         * ten cents a SECOND, and a mistyped loop is the first thing here that can spend a hundred
         * dollars before anybody notices.
         */
        monthly_cap_cents INTEGER   NOT NULL DEFAULT 2000,

        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT video_credentials_cap_ck CHECK (monthly_cap_cents BETWEEN 100 AND 100000)
      );
    `)

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS social.reels (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title          TEXT         NOT NULL,
        brand          VARCHAR(32)  NOT NULL,
        aspect_ratio   VARCHAR(8)   NOT NULL DEFAULT '9:16',
        resolution     VARCHAR(8)   NOT NULL DEFAULT '720p',

        /* What the operator is aiming for. Not enforced — the model decides clip length — but it
           is what the screen counts towards and what warns when the 40s ceiling is near. */
        target_seconds INTEGER      NOT NULL DEFAULT 25,

        status         VARCHAR(16)  NOT NULL DEFAULT 'building',
        created_by     UUID         REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT reels_brand_ck  CHECK (brand IN ('pranajiva', 'crossfriend')),
        CONSTRAINT reels_status_ck CHECK (status IN ('building', 'done', 'abandoned')),
        /* The model offers no other framings, so anything else is a request it would refuse. */
        CONSTRAINT reels_aspect_ck CHECK (aspect_ratio IN ('9:16', '16:9')),
        CONSTRAINT reels_res_ck    CHECK (resolution IN ('360p', '720p', '1080p', '4k')),
        /* 40 seconds is the model's hard ceiling for a chained clip; below 3 nothing can be made. */
        CONSTRAINT reels_target_ck CHECK (target_seconds BETWEEN 3 AND 40)
      );
    `)

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS reels_recent_idx ON social.reels (created_at DESC);
    `)

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS social.reel_shots (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reel_id             UUID         NOT NULL REFERENCES social.reels(id) ON DELETE CASCADE,

        /* 1 is the opening shot. Everything above it is a continuation of the one before. */
        seq                 INTEGER      NOT NULL,

        mode                VARCHAR(16)  NOT NULL,
        prompt              TEXT         NOT NULL,

        /* S3 keys, not data. An anchor image is uploaded once and may be reused by later shots. */
        first_image_key     TEXT,
        last_image_key      TEXT,

        /**
         * The chain itself.
         *
         * prev_interaction_id is what this shot continued from and interaction_id is what the
         * next shot will continue from. Google holds the video behind that id, so it is the only
         * thing that makes a continuation possible — a shot whose id was lost can be watched but
         * never extended.
         */
        prev_interaction_id TEXT,
        interaction_id      TEXT,

        video_key           TEXT,
        video_url           TEXT,
        seconds             NUMERIC(5,2),

        /* What we observed, not what we assumed. NULL until a continuation has been measured. */
        cumulative          BOOLEAN,

        status              VARCHAR(16)  NOT NULL DEFAULT 'queued',
        error               TEXT,

        /* Charged in US cents at generation time, so a reel's cost survives a price change. */
        cost_cents          INTEGER,

        created_by          UUID         REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        started_at          TIMESTAMPTZ,
        finished_at         TIMESTAMPTZ,
        created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT reel_shots_mode_ck   CHECK (mode IN ('text', 'image', 'first_last', 'continue')),
        CONSTRAINT reel_shots_status_ck CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
        /**
         * One shot per position, which is what stops a double-clicked Generate button from
         * spending twice. The money is the reason this is a constraint and not a check in the
         * screen: a duplicate here is not a messy row, it is a charge.
         */
        CONSTRAINT reel_shots_seq_uniq  UNIQUE (reel_id, seq),
        CONSTRAINT reel_shots_seq_ck    CHECK (seq >= 1),
        /* A continuation without something to continue from is not a continuation. */
        CONSTRAINT reel_shots_chain_ck  CHECK (mode <> 'continue' OR seq > 1)
      );
    `)

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS reel_shots_reel_idx ON social.reel_shots (reel_id, seq);
      /* The sweep that finishes renders nobody is watching. */
      CREATE INDEX IF NOT EXISTS reel_shots_rendering_idx ON social.reel_shots (started_at)
        WHERE status = 'rendering';
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS social.reel_shots;`)
    await queryRunner.query(`DROP TABLE IF EXISTS social.reels;`)
    await queryRunner.query(`DROP TABLE IF EXISTS social.video_credentials;`)
    /* The schema itself is left in place: dropping it would take anything else that had since been
       created inside it, and an empty schema costs nothing. */
  }
}
