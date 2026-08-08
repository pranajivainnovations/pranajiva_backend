import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Baker Portal — invite-only baker identity, and the authoritative baker↔product ownership record.
 *
 * Purely additive: three new tables plus one new column on baker_network.bakers. Nothing in
 * public.* (Medusa's own tables) is touched, so Pranajiva is unaffected by construction.
 *
 * ── How a baker comes to exist ────────────────────────────────────────────────────────────────
 * There is no public registration. The pipeline is:
 *
 *   Google Places sweep  ->  baker_discoveries          (unclaimed, no login)
 *          |  ops promotes
 *          v
 *   bakers  (public_id assigned automatically here)     (unclaimed, no login)
 *          |  ops issues an activation
 *          v
 *   baker_activations  (single-use token, emailed/sent to the baker)
 *          |  baker sets their own password
 *          v
 *   baker_users  (role 'owner')                          (claimed — can log in)
 *
 * "Claimed" is deliberately NOT a column on bakers. It is exactly "an active baker_users row
 * exists", and storing that separately would create a second source of truth that can drift out of
 * sync with the thing it describes. idx_baker_users_baker makes the EXISTS check cheap.
 *
 * Blue tick is entirely separate and stays where it already is (bakers.blue_tick). Claiming an
 * account is proof of control; a blue tick is proof of quality. Nothing in this migration reads or
 * writes it — a baker can be fully activated and selling with no blue tick, which is the point.
 *
 * ── Why login is Baker ID + password, not email ───────────────────────────────────────────────
 * Bakers are onboarded by ops from Google Places data, where the email is frequently missing,
 * shared across outlets, or simply wrong. An identifier we mint ourselves is always present,
 * always unique, and can be read out over a phone call during onboarding. Email is kept on
 * baker_users for contact and future password recovery, never as the credential.
 */
export class CreateBakerPortalSchema1723400000000 implements MigrationInterface {
  name = "CreateBakerPortalSchema1723400000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Human-friendly, immutable Baker ID ──────────────────────────────────────────────────
    // Format: CFB-00042. Sequential rather than random because this is read aloud during
    // onboarding calls and typed into a login form by someone who is not a computer user —
    // "CFB dash four two" beats any base32 scheme for that. It leaks nothing worth protecting
    // (an approximate count of bakers), and it is stable for the life of the record: renaming a
    // bakery, changing its owner, or moving it to a new city never changes this.
    await queryRunner.query(`
      CREATE SEQUENCE IF NOT EXISTS baker_network.baker_public_id_seq AS BIGINT START WITH 1;
    `)

    await queryRunner.query(`
      ALTER TABLE baker_network.bakers
        ADD COLUMN IF NOT EXISTS public_id VARCHAR(16);
    `)

    // Backfill before the NOT NULL / UNIQUE constraints go on, so existing bakers get IDs in a
    // stable order rather than whatever order the rewrite happens to visit them in.
    await queryRunner.query(`
      UPDATE baker_network.bakers b
         SET public_id = 'CFB-' || LPAD(nextval('baker_network.baker_public_id_seq')::TEXT, 5, '0')
       WHERE public_id IS NULL;
    `)

    await queryRunner.query(`
      ALTER TABLE baker_network.bakers
        ALTER COLUMN public_id SET NOT NULL,
        ALTER COLUMN public_id SET DEFAULT
          'CFB-' || LPAD(nextval('baker_network.baker_public_id_seq')::TEXT, 5, '0');
    `)

    // Case-insensitive uniqueness: the ID is minted upper case, but it is typed by hand at login,
    // so "cfb-00042" must not be able to become a second baker.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_bakers_public_id ON baker_network.bakers (UPPER(public_id));
    `)

    // Immutability, enforced by the database rather than by convention.
    //
    // A Baker ID is printed on onboarding paperwork, read out over the phone, and typed into the
    // login form every day thereafter. If one ever changed, that baker would be locked out with no
    // self-service way back in, and any external reference to it would silently point at nothing.
    // Application code will never update this column — but "will never" is a promise about code
    // that does not exist yet, whereas a trigger is a promise the database keeps on its own,
    // including against an ad-hoc UPDATE run by a human at 2am.
    //
    // Deliberately raises rather than silently restoring the old value: a caller that tried to
    // change it has a bug, and hiding that would only delay finding it.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION baker_network.reject_public_id_change()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
          RAISE EXCEPTION
            'baker public_id is immutable (attempted % -> %)', OLD.public_id, NEW.public_id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)

    await queryRunner.query(`
      CREATE TRIGGER trg_bakers_public_id_immutable
        BEFORE UPDATE OF public_id ON baker_network.bakers
        FOR EACH ROW EXECUTE FUNCTION baker_network.reject_public_id_change();
    `)

    // ── Baker users ─────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,

        -- Contact and future password recovery only. NEVER the login credential — see the file
        -- comment. Nullable because a promoted Google Places record often has no usable email.
        email VARCHAR(255),
        password_hash TEXT NOT NULL,
        name TEXT,

        -- V1 treats both roles identically. The column exists now because adding a role to a
        -- populated auth table later means a migration plus re-auditing every authorization
        -- check; adding it before there are any users costs one line.
        role VARCHAR(20) NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff')),

        is_active BOOLEAN NOT NULL DEFAULT true,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    // Partial index — every lookup is "the active users of this baker", never a full scan.
    await queryRunner.query(`
      CREATE INDEX idx_baker_users_baker ON baker_network.baker_users (baker_id) WHERE is_active;
    `)

    // Exactly one active owner per baker. This is what makes "Baker ID + password" unambiguous:
    // the ID resolves to a baker, the baker resolves to exactly one owner account. Staff users
    // (role 'staff') are unconstrained here and will need their own login identifier when
    // multi-user lands — that is an additive change to this table, not a redesign.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_baker_users_one_active_owner
        ON baker_network.baker_users (baker_id)
        WHERE role = 'owner' AND is_active;
    `)

    // Case-insensitive, and only where an email is actually set — two bakers with no email must
    // not collide with each other.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_baker_users_email
        ON baker_network.baker_users (LOWER(email))
        WHERE email IS NOT NULL;
    `)

    // ── Activation tokens ───────────────────────────────────────────────────────────────────
    // Single-use invitations. The raw token is shown to ops exactly once, at creation, and only
    // its SHA-256 hash is stored — so a database leak (or a curious OPS user with the Database
    // Explorer) cannot be turned into a baker account takeover. Same reasoning as password_hash.
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_activations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,

        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,

        -- Set the moment the token is redeemed. Presence of this is what makes it single-use;
        -- the row is kept rather than deleted so ops can see that an invite was used and when.
        used_at TIMESTAMPTZ,
        used_by UUID REFERENCES baker_network.baker_users(id) ON DELETE SET NULL,

        -- Nullable: revoked when ops reissues, so an old invite in an inbox stops working.
        revoked_at TIMESTAMPTZ,

        created_by UUID REFERENCES baker_network.ops_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    // At most one live invitation per baker. Reissuing must revoke the previous one rather than
    // leaving two valid tokens in circulation.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_baker_activations_one_live
        ON baker_network.baker_activations (baker_id)
        WHERE used_at IS NULL AND revoked_at IS NULL;
    `)

    // ── Baker ↔ Medusa product ownership ────────────────────────────────────────────────────
    // The authoritative answer to "who owns this product". Every baker-scoped read and write
    // joins through here using the baker_id resolved from the session cookie — never a baker_id
    // supplied by the browser, and never product metadata.
    //
    // No foreign key to public.product on purpose: Medusa owns that table's migration lifecycle,
    // and a cross-schema FK would couple our migrations to theirs (and make Medusa's own product
    // deletion paths fail in ways its code does not expect). The service layer writes this row
    // inside the same transaction as the product, and a reconciliation query surfaces drift.
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,

        -- UNIQUE on its own, not just within a baker: a Medusa product has exactly ONE owner.
        -- UNIQUE(baker_id, medusa_product_id) alone would happily allow two bakers to claim the
        -- same product, which is the one thing this table exists to prevent.
        medusa_product_id VARCHAR(255) NOT NULL UNIQUE,

        -- CrossFriend's own lifecycle. Deliberately NOT Medusa's product.status: AI Studio
        -- already uses Medusa 'draft' to mean "bespoke cake, must never appear in a catalogue",
        -- and overloading it would make those two very different states indistinguishable.
        -- A separate projection step maps this onto Medusa status + sales channel membership.
        publication_state VARCHAR(20) NOT NULL DEFAULT 'draft'
          CHECK (publication_state IN ('draft', 'published', 'unavailable', 'archived')),
        published_at TIMESTAMPTZ,

        created_by UUID REFERENCES baker_network.baker_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    // Covers the portal's only list query: this baker's products, filtered by state, newest first.
    await queryRunner.query(`
      CREATE INDEX idx_baker_products_listing
        ON baker_network.baker_products (baker_id, publication_state, updated_at DESC);
    `)

    // Covers the marketplace's reverse lookup: given a product, who bakes it.
    await queryRunner.query(`
      CREATE INDEX idx_baker_products_published
        ON baker_network.baker_products (publication_state, baker_id)
        WHERE publication_state = 'published';
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_products;`)
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_activations;`)
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_users;`)

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_bakers_public_id_immutable ON baker_network.bakers;
    `)
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS baker_network.reject_public_id_change();
    `)
    await queryRunner.query(`DROP INDEX IF EXISTS baker_network.idx_bakers_public_id;`)
    await queryRunner.query(`
      ALTER TABLE baker_network.bakers DROP COLUMN IF EXISTS public_id;
    `)
    await queryRunner.query(`DROP SEQUENCE IF EXISTS baker_network.baker_public_id_seq;`)
  }
}
