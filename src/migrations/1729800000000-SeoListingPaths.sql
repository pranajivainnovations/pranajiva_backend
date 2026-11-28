-- Manual equivalent of 1729800000000-SeoListingPaths.ts
--
-- SEO monitor: set PranaJiva's listing pages (shop, Glow Care collection, corporate gifting) for the
-- "listing-empty" check, only if none are set yet. The final INSERT registers it in TypeORM's ledger
-- so `medusa migrations run` skips it.

BEGIN;

UPDATE seo.sites
   SET settings = settings || '{"listingPaths": ["/shop", "/collections/glow-care", "/corporate-gifting"]}'::jsonb,
       updated_at = NOW()
 WHERE slug = 'pranajiva' AND NOT (settings ? 'listingPaths');

INSERT INTO migrations ("timestamp", name) VALUES (1729800000000, 'SeoListingPaths1729800000000');

COMMIT;
