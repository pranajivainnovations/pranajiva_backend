import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The shareable half of a referral — GS-5.1.
 *
 * ── Why a stored code rather than one derived from the customer ────────────────────────────────
 * A code computed from the customer id — a hash, a hashid, an encoded integer — needs no table and
 * is the obvious shortcut. It is also a permanent handle on the customer that cannot be withdrawn:
 * the mapping is the algorithm, so a code that turns up in a fraud ring cannot be revoked without
 * revoking the algorithm for everybody, and anybody who works out the scheme can enumerate customers
 * rather than guess them. A row can be deleted. A formula cannot.
 *
 * ── The alphabet, and why it is missing letters ────────────────────────────────────────────────
 * No vowels, so a random draw can never spell a word — nobody should have to explain why our system
 * handed a customer an obscene referral code. No 0/O, 1/I/L, which are the characters people
 * mistranscribe when reading a code off a screenshot or hearing it over a phone. What remains is 28
 * symbols; eight of them is about 38 bits, which is far past the point where guessing is a cheaper
 * attack than simply signing up.
 *
 * ── Immutable, but revocable ───────────────────────────────────────────────────────────────────
 * UPDATE is refused and DELETE is not, and the asymmetry is deliberate. A code that changes silently
 * breaks every link the customer has already shared — a WhatsApp message sent last week stops
 * attributing and nobody finds out. Deleting one is an act somebody has to choose, for a code that
 * is being abused; it breaks the same links, but on purpose and with a person behind it.
 */
export class CreateReferralCodes1726100000000 implements MigrationInterface {
  name = "CreateReferralCodes1726100000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallet.referral_codes (
        code         text        PRIMARY KEY,
        customer_id  text        NOT NULL UNIQUE
                                 REFERENCES public.customer(id) ON DELETE CASCADE,
        created_at   timestamptz NOT NULL DEFAULT now(),

        /* The generator's alphabet, enforced by the database rather than trusted to it. A code that
           does not match this shape did not come from generateCode, and the place to find that out
           is the insert that wrote it. */
        CONSTRAINT referral_codes_shape
          CHECK (code ~ '^[2-9BCDFGHJKMNPQRSTVWXYZ]{8}$')
      );

      /* One code per customer is the UNIQUE above; this is the lookup that every shared link
         performs, and it is the primary key, so no further index is needed. The reverse direction —
         "what is my code" — is served by the unique constraint on customer_id. */

      CREATE TRIGGER wallet_referral_codes_immutable
        BEFORE UPDATE ON wallet.referral_codes
        FOR EACH ROW EXECUTE FUNCTION wallet.refuse_mutation();
    `)
  }

  /**
   * Safe to reverse. Codes are re-derivable in the sense that matters — a customer who loses one is
   * issued another on their next visit to the referral screen — and no money is recorded here. The
   * attributions themselves live in wallet.referrals and are untouched by this.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS wallet.referral_codes`)
  }
}
