import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * SEO monitor: give PranaJiva its listing pages.
 *
 * The monitor's new "listing-empty" check needs to know which pages must always show products, so a
 * shop page cached empty during a catalogue outage is caught. Set only where the site has none yet,
 * so a value edited in OPS is never overwritten. Data only; no schema change.
 */
export const SEO_LISTING_PATHS_SQL = `
UPDATE seo.sites
   SET settings = settings || '{"listingPaths": ["/shop", "/collections/glow-care", "/corporate-gifting"]}'::jsonb,
       updated_at = NOW()
 WHERE slug = 'pranajiva' AND NOT (settings ? 'listingPaths');
`

export class SeoListingPaths1729800000000 implements MigrationInterface {
  name = "SeoListingPaths1729800000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(SEO_LISTING_PATHS_SQL)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE seo.sites SET settings = settings - 'listingPaths' WHERE slug = 'pranajiva';`)
  }
}
