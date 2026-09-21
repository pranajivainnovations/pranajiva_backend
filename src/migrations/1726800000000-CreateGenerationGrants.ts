import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Extra Studio generations, given by hand.
 *
 * ── Why a table and not a number on the customer ───────────────────────────────────────────────
 * A column called `extra_generations` would answer "how many may they have" and nothing else. The
 * questions that actually get asked are "who gave these, when, and why" — asked by the next person
 * on support, and asked by whoever notices one account has had sixty. A row per grant answers all
 * four; a counter answers one and quietly loses the rest on every edit.
 *
 * So this is the same shape as a manual wallet grant, for the same reason: the thing that stands in
 * for a budget on a discretionary give-away is that every one of them is visible next to the form
 * that makes the next one.
 *
 * ── Why it is not in the wallet ────────────────────────────────────────────────────────────────
 * Generations are not money. Putting them in wallet.entries would mean a balance that is part rupees
 * and part image credits, and it would break the rule the wallet is built on — earn-only, no top-up,
 * no instrument. A customer must never be able to convert credit into generations or the reverse.
 * Separate tables is what makes that structural instead of a convention somebody later forgets.
 *
 * ── Append-only, like the ledger ───────────────────────────────────────────────────────────────
 * The allowance is derived by summing these rows. An UPDATE would silently rewrite what somebody was
 * given, so the database refuses it. Taking generations back is not supported and is not an
 * oversight: nobody has ever needed to un-give five images, and a grant that can be revoked is a
 * grant support has to explain.
 */
export class CreateGenerationGrants1726800000000 implements MigrationInterface {
  name = "CreateGenerationGrants1726800000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ai_studio.generation_grants (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        /* Not a foreign key, matching ai_studio.generations: this schema deliberately does not
           constrain against Medusa's core customer table. */
        customer_id  character varying NOT NULL,

        /* How many extra generations. Always a give, never a take — see the note above. */
        amount       integer NOT NULL,

        /* Both mandatory. A discretionary grant with no reason and no author is indistinguishable
           from an accident, and the reason is usually the only record of the conversation that
           produced it. */
        reason       text NOT NULL,
        created_by   uuid NOT NULL REFERENCES baker_network.ops_users(id),

        created_at   timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT generation_grants_amount_ck CHECK (amount > 0 AND amount <= 500),
        CONSTRAINT generation_grants_reason_ck CHECK (length(btrim(reason)) >= 3)
      );
    `)

    /* The allowance query reads every grant for one customer, and the OPS list reads the newest
       across all of them. One index each. */
    await queryRunner.query(`
      CREATE INDEX generation_grants_customer_idx
        ON ai_studio.generation_grants (customer_id);
      CREATE INDEX generation_grants_created_idx
        ON ai_studio.generation_grants (created_at DESC);
    `)

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ai_studio.refuse_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION
          'ai_studio.% is append-only: % is not permitted. Write another grant instead.',
          TG_TABLE_NAME, TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER generation_grants_append_only
        BEFORE UPDATE OR DELETE ON ai_studio.generation_grants
        FOR EACH ROW EXECUTE FUNCTION ai_studio.refuse_mutation();
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* DROP TABLE is DDL, not DML, so the append-only trigger does not stand in its way — the trigger
       refuses row changes, and dropping the table takes the trigger with it. */
    await queryRunner.query(`DROP TABLE IF EXISTS ai_studio.generation_grants;`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS ai_studio.refuse_mutation();`)
  }
}
