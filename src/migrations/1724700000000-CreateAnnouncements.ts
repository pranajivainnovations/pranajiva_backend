import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Site-wide announcements, composed in OPS and shown to every storefront visitor.
 *
 * ── Why structured fields rather than a blob of HTML ───────────────────────────────────────────
 * The obvious build is a rich-text editor storing HTML. It is the wrong one for a public page. Free
 * HTML on the storefront is an injection surface that has to be sanitised on every render, and even
 * when it is safe it lets a well-meaning person publish something that is off-brand, unreadable on a
 * phone, or quietly broken — and it will be live for everyone before anyone notices.
 *
 * So the shape is fixed and the freedom is inside it: a headline, a short body, an image, a theme
 * chosen from brand presets, and one optional button. That covers images, colour and typography —
 * which is what was actually wanted — while making it impossible to publish something that does not
 * look like CrossFriend or that carries a script.
 *
 * ── Why a table rather than a row in site_settings ─────────────────────────────────────────────
 * Announcements have a life: drafted, scheduled, live, expired, and worth looking back at. A single
 * settings row would make every new one destroy the last, so there would be no record of what was
 * said to customers or when — which is the first thing anybody asks after a bad week.
 */
export class CreateAnnouncements1724700000000 implements MigrationInterface {
  name = "CreateAnnouncements1724700000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.announcements (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        title       VARCHAR(120) NOT NULL,
        /* Markdown-lite, rendered by a small allow-list on the storefront — bold, italic, links,
           line breaks. Not HTML, so there is nothing to sanitise and nothing to escape wrongly. */
        body        TEXT NOT NULL DEFAULT '',

        /* Optional, and always a URL we uploaded rather than one somebody pasted — see the OPS
           composer. A remote image would be a layout and privacy surprise on every page load. */
        image_url   TEXT,

        /* A named preset, not a hex value. Arbitrary colours are how a brand palette dies, and a
           contrast failure published site-wide is not something a colour picker can prevent. */
        theme       VARCHAR(24) NOT NULL DEFAULT 'purple',

        cta_label   VARCHAR(40),
        cta_url     TEXT,

        /* Scheduling, both optional. Null start means "as soon as it is published", null end means
           "until somebody turns it off" — which is the honest default, because an announcement with
           no expiry is a decision somebody made, not an accident the schema should prevent. */
        starts_at   TIMESTAMPTZ,
        ends_at     TIMESTAMPTZ,

        /* Publishing is separate from scheduling on purpose. A draft with dates on it is still a
           draft, and one switch that means "customers can see this" is easier to reason about at
           speed than inferring it from two timestamps. */
        is_published BOOLEAN NOT NULL DEFAULT FALSE,

        created_by  UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT announcements_title_not_blank CHECK (length(btrim(title)) > 0),
        /* A button with a label and no destination is a dead control on a live site; one with a
           destination and no label is invisible. Both or neither. */
        CONSTRAINT announcements_cta_complete
          CHECK ((cta_label IS NULL) = (cta_url IS NULL)),
        CONSTRAINT announcements_window_ordered
          CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
      )
    `)

    /**
     * The storefront asks one question on every page load — "is anything live right now" — and this
     * is the index that answers it without reading the drafts and the history.
     */
    await queryRunner.query(`
      CREATE INDEX announcements_live_idx
        ON crossfriend.announcements (starts_at, ends_at)
        WHERE is_published
    `)

    await queryRunner.query(`
      CREATE INDEX announcements_recent_idx
        ON crossfriend.announcements (created_at DESC)
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.announcements`)
  }
}
