import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The contact details and social handles the public storefront shows.
 *
 * These were hardcoded in component files, and one of them was wrong in a way nobody could see
 * from the outside: the WhatsApp button on every page pointed at 919876543210 — the standard dummy
 * Indian number — with a "Replace with actual number" comment still attached. Three separate files
 * carried that same literal. A customer clicking Chat on WhatsApp reached a stranger, and nothing
 * about the site looked broken.
 *
 * That is the real argument for this table. Contact details change (a new support line, a social
 * account, a grievance officer) and each change currently means editing several files, rebuilding
 * and redeploying — so in practice they do not get changed, they get left wrong.
 *
 * Key/value rather than a column per setting: the field catalogue (labels, grouping, validation)
 * lives in OPS code where it is easy to extend, so adding "YouTube" later is a one-line change
 * instead of a migration. The keys are still constrained — the OPS action writes only keys it
 * knows, so a typo cannot silently create a setting nothing reads.
 */
export class CreateSiteSettings1723900000000 implements MigrationInterface {
  name = "CreateSiteSettings1723900000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.site_settings (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    /**
     * Seeded with the real support number from the legal pages, which is the number already
     * printed on six policy documents and is therefore certainly ours.
     *
     * WhatsApp is seeded to that same number as the best available guess — it may well be a
     * different line, and OPS can change it in seconds. The point is that the wrong-by-default
     * value is now a number we own rather than someone else's.
     *
     * Social handles are seeded empty on purpose. An empty value means "do not render this link"
     * downstream; a placeholder URL would put a dead link on every page.
     */
    await queryRunner.query(`
      INSERT INTO crossfriend.site_settings (key, value) VALUES
        ('whatsapp_number',   '919821101868'),
        ('support_phone',     '+91 98211 01868'),
        ('support_email',     'support@crossfriend.in'),
        ('grievance_name',    'Pranajiva Director'),
        ('grievance_email',   'director@crossfriend.in'),
        ('instagram_url',     ''),
        ('facebook_url',      ''),
        ('linkedin_url',      ''),
        ('youtube_url',       ''),
        ('x_url',             ''),
        ('google_business_url', '')
      ON CONFLICT (key) DO NOTHING;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.site_settings;`)
  }
}
