import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Where people are asking from — including where we cannot yet deliver.
 *
 * ── Why this is worth recording at all ─────────────────────────────────────────────────────────
 * Until now a pincode check was answered and forgotten. The only visitors who left any trace were
 * the ones who went on to hand over a mobile number for the waitlist, which is a small and
 * self-selecting fraction — so "where is the demand" could only be answered from the places we
 * already serve, which is the one place the question does not need asking.
 *
 * Now that every arriving visitor is asked, the answer is a genuine map of where people want cakes,
 * gathered before a single baker has been approached. That is the input to deciding which pincode
 * opens next, and it cannot be reconstructed later from anything.
 *
 * ── Why a day and a count rather than a row per ask ────────────────────────────────────────────
 * The question this answers is "how many, where, and is it growing" — all of which a daily tally
 * answers exactly as well as a log of individual events, while staying small enough to keep for
 * years. A row per ask would be millions of rows to compute the same three numbers.
 *
 * ── Why there is nothing here that identifies anybody ──────────────────────────────────────────
 * No mobile, no customer, no address, no IP. A pincode and a date is not personal data and cannot be
 * turned back into a person, which means this table can be kept indefinitely and shown to anybody
 * without a second thought. The waitlist already holds the identified version for the people who
 * explicitly asked to be told, and that is the right place for it.
 */
export class CreatePincodeInterest1726500000000 implements MigrationInterface {
  name = "CreatePincodeInterest1726500000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE crossfriend.pincode_interest (
        pincode  varchar(6) NOT NULL,
        day      date       NOT NULL,
        /* What we could offer them that day, so a rise in asks can be read against whether we had
           become able to serve them in the meantime. */
        tier     text       NOT NULL,
        asks     integer    NOT NULL DEFAULT 1,

        PRIMARY KEY (pincode, day, tier),
        CONSTRAINT pincode_interest_pincode_ck CHECK (pincode ~ '^[1-9][0-9]{5}$'),
        CONSTRAINT pincode_interest_tier_ck
          CHECK (tier IN ('deliver', 'design_only', 'unknown')),
        CONSTRAINT pincode_interest_asks_ck CHECK (asks > 0)
      );

      /* The report this exists for: the places we do not serve, busiest first. */
      CREATE INDEX pincode_interest_by_day
        ON crossfriend.pincode_interest (day DESC, asks DESC);
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS crossfriend.pincode_interest`)
  }
}
