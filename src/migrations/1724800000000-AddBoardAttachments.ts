import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Images and link previews on team board messages.
 *
 * ── Why the preview is stored and not fetched at render time ───────────────────────────────────
 * A board of 500 messages would otherwise make 500 outbound HTTP requests every time somebody opened
 * it — to third-party sites, from our server, with the page waiting. Worse, the result would change
 * under the reader: a link posted last month would silently re-render with whatever that page says
 * today, or become an empty card the day it 404s. What was shared is what the poster saw, so it is
 * captured once at post time and kept. If the fetch fails, the columns stay null and the message is
 * a plain link — which is what it was anyway.
 *
 * ── Why the image is a URL and not bytes ───────────────────────────────────────────────────────
 * The same S3 bucket already holds baker and announcement images, and putting binaries in Postgres
 * would make every board read carry them. `image_url` is our own bucket by construction — the upload
 * happens in OPS and this column never receives anything a user typed.
 *
 * `link_image_url`, by contrast, IS a remote URL chosen by whoever wrote the link. It is rendered in
 * an <img> and nowhere else, never fetched server-side after this, and constrained to http(s) by the
 * code that writes it.
 */
export class AddBoardAttachments1724800000000 implements MigrationInterface {
  name = "AddBoardAttachments1724800000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE crossfriend.team_messages
        ADD COLUMN IF NOT EXISTS image_url        TEXT,
        ADD COLUMN IF NOT EXISTS link_url         TEXT,
        ADD COLUMN IF NOT EXISTS link_title       TEXT,
        ADD COLUMN IF NOT EXISTS link_description TEXT,
        ADD COLUMN IF NOT EXISTS link_image_url   TEXT,
        ADD COLUMN IF NOT EXISTS link_site        TEXT
    `)

    /**
     * A message may now be an image with nothing written on it.
     *
     * The original constraint required a non-blank body, which was right when text was the only
     * thing a message could be. Sending a photo without a caption is ordinary, so the rule becomes
     * "a message must carry something" rather than "a message must have words" — an empty row with
     * neither is still rejected, which is the part worth keeping.
     */
    await queryRunner.query(`
      ALTER TABLE crossfriend.team_messages
        DROP CONSTRAINT IF EXISTS team_messages_body_not_blank
    `)
    await queryRunner.query(`
      ALTER TABLE crossfriend.team_messages
        ADD CONSTRAINT team_messages_has_content
        CHECK (length(btrim(body)) > 0 OR image_url IS NOT NULL)
    `)

    /* A preview without its link would render a card pointing nowhere. The other four link columns
       are all optional — plenty of pages have an og:title and no description, or no image. */
    await queryRunner.query(`
      ALTER TABLE crossfriend.team_messages
        ADD CONSTRAINT team_messages_preview_has_link
        CHECK (link_url IS NOT NULL
               OR (link_title IS NULL AND link_description IS NULL
                   AND link_image_url IS NULL AND link_site IS NULL))
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * Restoring the old constraint would fail against any image-only message written in the
     * meantime, so those are given a placeholder body first. Losing a caption that was never typed
     * is a better outcome than a rollback that cannot run.
     */
    await queryRunner.query(`
      UPDATE crossfriend.team_messages
         SET body = '(image)'
       WHERE length(btrim(body)) = 0
    `)

    await queryRunner.query(`
      ALTER TABLE crossfriend.team_messages
        DROP CONSTRAINT IF EXISTS team_messages_preview_has_link,
        DROP CONSTRAINT IF EXISTS team_messages_has_content
    `)
    await queryRunner.query(`
      ALTER TABLE crossfriend.team_messages
        ADD CONSTRAINT team_messages_body_not_blank CHECK (length(btrim(body)) > 0)
    `)
    await queryRunner.query(`
      ALTER TABLE crossfriend.team_messages
        DROP COLUMN IF EXISTS image_url,
        DROP COLUMN IF EXISTS link_url,
        DROP COLUMN IF EXISTS link_title,
        DROP COLUMN IF EXISTS link_description,
        DROP COLUMN IF EXISTS link_image_url,
        DROP COLUMN IF EXISTS link_site
    `)
  }
}
