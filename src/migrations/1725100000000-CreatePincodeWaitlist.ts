import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Who asked to be told when we reach their pincode.
 *
 * ── Why this table earns its place ─────────────────────────────────────────────────────────────
 * Delivery is live in a handful of pincodes and the studio is free everywhere, so most visitors who
 * type a pincode are told we cannot deliver to them yet. That moment currently ends the
 * conversation. It is also the single most honest demand signal the business can collect: somebody
 * who wants a cake, in a named place, on a known date. Stored, it answers "which pincode do we
 * launch next" with evidence instead of instinct — and OPS already owns launching pincodes, so the
 * answer lands where the decision is made.
 *
 * ── Why (pincode, mobile) is unique ────────────────────────────────────────────────────────────
 * The same person will hit the same dead end more than once — a second product, a second visit, a
 * mis-typed digit corrected. Without the constraint, one interested customer becomes five rows and
 * the pincode looks five times more in demand than it is, which is exactly the number somebody
 * would use to pick a launch. ON CONFLICT DO UPDATE keeps the first `created_at` (when they first
 * wanted us) while refreshing `last_asked_at`, so both "how long have they waited" and "are they
 * still interested" survive.
 *
 * ── Why the mobile number is stored plainly and the consent is explicit ────────────────────────
 * We have to be able to call or message this number later — that is the entire point — so it cannot
 * be hashed like a credential. What that obliges instead is a purpose record: under the DPDP Act
 * consent is specific, and "tell me when you deliver here" is not consent to marketing. The purpose
 * is fixed in `consent_context`, and `notified_at` closes the loop, so a number cannot quietly stay
 * on a list forever after the thing it was collected for has already happened.
 *
 * No foreign key to customer, matching push_subscribers: this is written by a public endpoint, and a
 * constraint against Medusa's customer table would let a caller learn which ids exist by watching
 * which writes fail. customer_id is recorded when we happen to know it and never joined on.
 */
export class CreatePincodeWaitlist1725100000000 implements MigrationInterface {
  name = "CreatePincodeWaitlist1725100000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS crossfriend.pincode_waitlist (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        pincode         VARCHAR(6) NOT NULL,
        mobile          VARCHAR(10) NOT NULL,

        customer_id     TEXT,

        /* Which dead end they hit — the studio's out-of-coverage panel, a product page, or the
           standalone checker. Tells us whether people are asking after seeing a design they want
           (high intent) or before (curiosity), which are worth different amounts. */
        source          TEXT NOT NULL DEFAULT 'unknown',

        /* Demonstrable, and narrow. This is permission to say "we deliver to you now", nothing else. */
        consented_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        consent_context TEXT NOT NULL DEFAULT 'pincode_waitlist',

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_asked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        /* Set when the "we're here now" message actually goes out, so nobody is told twice and the
           list can be reconciled against what was sent. */
        notified_at     TIMESTAMPTZ,

        CONSTRAINT pincode_waitlist_mobile_is_10_digits CHECK (mobile ~ '^[6-9][0-9]{9}$'),
        CONSTRAINT pincode_waitlist_pincode_is_6_digits CHECK (pincode ~ '^[0-9]{6}$'),
        CONSTRAINT pincode_waitlist_unique_person_per_pincode UNIQUE (pincode, mobile)
      );
    `)

    /* The launch question — "how many people are waiting in each pincode, and who has not been told
       yet" — is the only query this table exists to answer, so it is the one that gets an index. */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_pincode_waitlist_pending
        ON crossfriend.pincode_waitlist (pincode)
        WHERE notified_at IS NULL;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.pincode_waitlist;`)
  }
}
