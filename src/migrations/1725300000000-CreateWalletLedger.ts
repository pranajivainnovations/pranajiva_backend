import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The customer wallet — GS-2.1 of the growth system build.
 *
 * ── Why a ledger and not a balance ─────────────────────────────────────────────────────────────
 * A balance column is one number that must be correct after every concurrent write, and when it is
 * wrong there is nothing to compare it against. An append-only ledger has no such number: the
 * balance is the sum of what happened, every movement keeps the reason it happened, and the question
 * support actually gets — "why does this customer have ₹340?" — is answerable a year later.
 *
 * This is also the one table in the growth system that cannot be repaired after the fact. The brand
 * and config-version stamps below describe the conditions an entry was computed under; if they are
 * not recorded as it is written, there is nowhere to recover them from later.
 *
 * ── Why its own schema ─────────────────────────────────────────────────────────────────────────
 * The wallet spans both brands by design — one balance, earned on either storefront, spent on
 * either. Putting it in `crossfriend` would name a shared thing after one of the two parties to it,
 * which is exactly the mistake the synthetic customer email made twice before it was moved to a
 * neutral domain.
 *
 * ── Why paise as BIGINT ────────────────────────────────────────────────────────────────────────
 * The `pricing` schema uses NUMERIC(10,2), but every amount here is either computed from a Medusa
 * order total or redeemed against one, and Medusa stores money as integer minor units. Converting at
 * that boundary twice per order is how fractions of a rupee start appearing in a balance. Integers
 * in the same unit as the system this trades with means the arithmetic is exact and the conversion
 * happens once, at display.
 *
 * Amounts are INR. There is no currency column because there is one currency; if that ever changes,
 * adding it is a cheap migration over rows that are all INR, whereas a summed balance that silently
 * mixes currencies is not cheap to fix at all.
 */
export class CreateWalletLedger1725300000000 implements MigrationInterface {
  name = "CreateWalletLedger1725300000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS wallet;`)

    /**
     * ── The sign convention ──────────────────────────────────────────────────────────────────────
     * Amounts are signed and the balance is their sum. Credit in is positive, credit out is
     * negative, and no code ever has to remember which types to add and which to subtract — a rule
     * that is obeyed in eleven places and forgotten in the twelfth.
     *
     * `reversal` is the one type allowed either sign, because it undoes whatever it points at:
     * reversing a grant removes credit, reversing a redemption returns it. The CHECK below pins the
     * direction of every other type so a grant can never be written negative by a caller that got
     * its arithmetic backwards.
     */
    await queryRunner.query(`
      CREATE TABLE wallet.entries (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id     TEXT NOT NULL REFERENCES public.customer(id) ON DELETE RESTRICT,

        entry_type      VARCHAR(24) NOT NULL,
        amount_paise    BIGINT NOT NULL,

        /* The brand that ISSUED this credit, not the brand it is spent on. Spending is cross-brand
           on purpose; funding is not, and without this one brand books growth the other pays for. */
        brand           VARCHAR(16) NOT NULL,

        /* The reward configuration version this amount was computed under, frozen at write time.
           Rates are versioned and never mutated, so cutting referral from 5% to 3% leaves yesterday's
           entries still explaining themselves. NULL for movements that no rate produced. */
        config_version  INTEGER,

        /* The order that caused this entry: the one a grant was earned on, or the one credit was
           spent against. NULL for manual grants and for expiry. */
        order_id        TEXT REFERENCES public."order"(id) ON DELETE RESTRICT,

        /* Grants expire; movements do not. The sweeper reads this, and the resolver spends
           soonest-expiring first so credit a customer worked for outlives credit we gave away. */
        expires_at      TIMESTAMPTZ,

        /* What this entry undoes — the grant an expiry consumed, the entry a reversal cancels. */
        source_entry_id UUID REFERENCES wallet.entries(id) ON DELETE RESTRICT,

        /* Mandatory on manual grants, and on nothing else. A goodwill credit with no stated reason
           and no name against it is indistinguishable from a mistake. */
        reason          TEXT,
        created_by      UUID REFERENCES baker_network.ops_users(id) ON DELETE RESTRICT,

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.entries
        ADD CONSTRAINT wallet_entries_type_ck CHECK (entry_type IN (
          'promo_grant', 'referral_earn', 'cashback_earn', 'manual_grant',
          'redemption', 'reversal', 'expiry'
        )),

        ADD CONSTRAINT wallet_entries_brand_ck CHECK (brand IN ('crossfriend', 'pranajiva')),

        /* Zero is never a fact worth recording, and it is usually a bug upstream. */
        ADD CONSTRAINT wallet_entries_nonzero_ck CHECK (amount_paise <> 0),

        ADD CONSTRAINT wallet_entries_direction_ck CHECK (
          CASE entry_type
            WHEN 'reversal' THEN TRUE
            WHEN 'redemption' THEN amount_paise < 0
            WHEN 'expiry'     THEN amount_paise < 0
            ELSE amount_paise > 0
          END
        ),

        /* Only grants carry an expiry. An expiring redemption is meaningless and would be read by
           the sweeper as credit to take away twice. */
        ADD CONSTRAINT wallet_entries_expiry_ck CHECK (
          expires_at IS NULL
          OR entry_type IN ('promo_grant', 'referral_earn', 'cashback_earn', 'manual_grant')
        ),

        ADD CONSTRAINT wallet_entries_manual_ck CHECK (
          entry_type <> 'manual_grant' OR (reason IS NOT NULL AND created_by IS NOT NULL)
        ),

        /**
         * A rate-derived amount must say which rate produced it.
         *
         * Enforceable from the start because nothing writes to this table yet, and the build order
         * puts the versioned config (GS-3.1) ahead of the first engine that grants (GS-4.1). Left
         * nullable and "added later" it would never be added, and the first un-versioned row makes
         * the column permanently untrustworthy for every row beside it.
         */
        ADD CONSTRAINT wallet_entries_config_version_ck CHECK (
          entry_type NOT IN ('promo_grant', 'referral_earn', 'cashback_earn')
          OR config_version IS NOT NULL
        ),

        ADD CONSTRAINT wallet_entries_reversal_source_ck CHECK (
          entry_type <> 'reversal' OR source_entry_id IS NOT NULL
        );
    `)

    /**
     * One grant per customer per order per type.
     *
     * The reward path is racy by nature — an order can be marked delivered by a webhook and by an
     * operator within the same second — and the failure mode of a double-granted reward is that we
     * pay it twice and find out from the liability report. A partial unique index makes the second
     * write fail rather than succeed quietly.
     *
     * Movements are excluded: a redemption can legitimately be reversed and re-made against the same
     * order, and constraining that would block a correction rather than a mistake.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX wallet_entries_one_grant_per_order
        ON wallet.entries (customer_id, entry_type, order_id)
        WHERE order_id IS NOT NULL
          AND entry_type IN ('promo_grant', 'referral_earn', 'cashback_earn');
    `)

    await queryRunner.query(`
      CREATE INDEX wallet_entries_customer_created
        ON wallet.entries (customer_id, created_at DESC);

      CREATE INDEX wallet_entries_unexpired
        ON wallet.entries (expires_at)
        WHERE expires_at IS NOT NULL;

      CREATE INDEX wallet_entries_order
        ON wallet.entries (order_id) WHERE order_id IS NOT NULL;
    `)

    /**
     * ── Which grant a redemption actually spent ──────────────────────────────────────────────────
     * The balance is a sum, but expiry is not: when ₹100 of promo credit expiring on Friday sits
     * beside ₹100 earned from a referral, and the customer spends ₹100, the sweeper on Friday has to
     * know which one is gone. A sum cannot answer that, and guessing it wrong either expires credit
     * the customer already spent or lets expired credit live on.
     *
     * So redemptions and expiries record the grants they consumed. This is lot accounting, and it is
     * the reason the ledger can be both append-only and correct about expiry: nothing is ever
     * updated, the remaining value of a grant is simply what has not been allocated away from it.
     */
    await queryRunner.query(`
      CREATE TABLE wallet.allocations (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        /* The redemption, expiry or reversal doing the consuming. */
        consuming_entry_id UUID NOT NULL REFERENCES wallet.entries(id) ON DELETE RESTRICT,

        /* The grant being consumed. */
        grant_entry_id    UUID NOT NULL REFERENCES wallet.entries(id) ON DELETE RESTRICT,

        /* Always positive: how much of the grant this movement took. Direction lives on the entry. */
        amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),

        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        /* A movement takes from any one grant at most once; it splits across grants by having
           several rows, not several rows against the same grant. */
        CONSTRAINT wallet_allocations_unique UNIQUE (consuming_entry_id, grant_entry_id),
        CONSTRAINT wallet_allocations_distinct_ck CHECK (consuming_entry_id <> grant_entry_id)
      );

      CREATE INDEX wallet_allocations_grant ON wallet.allocations (grant_entry_id);
    `)

    /**
     * ── Append-only, enforced ────────────────────────────────────────────────────────────────────
     * "Append-only" as a convention survives until the first production incident at 2am, when
     * updating one row looks like the quick fix and the audit trail quietly stops being true. The
     * database refuses instead.
     *
     * The correct way to undo anything here is another entry — a `reversal` — which leaves both the
     * mistake and the correction visible. That is not a nuisance: it is the property that makes a
     * balance defensible to the customer holding it.
     *
     * Deliberately not a blanket ban on superuser action: `ALTER TABLE wallet.entries DISABLE
     * TRIGGER wallet_entries_append_only` is available to someone who has decided, with intent, that
     * a row must change. The trigger exists so that decision has to be made rather than typed by
     * accident.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION wallet.refuse_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION
          'wallet.% is append-only: % is not permitted. Write a reversal entry instead.',
          TG_TABLE_NAME, TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER wallet_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet.entries
        FOR EACH ROW EXECUTE FUNCTION wallet.refuse_mutation();

      CREATE TRIGGER wallet_allocations_append_only
        BEFORE UPDATE OR DELETE ON wallet.allocations
        FOR EACH ROW EXECUTE FUNCTION wallet.refuse_mutation();
    `)

    /**
     * ── The referral edge ────────────────────────────────────────────────────────────────────────
     * One column, holding the whole graph. Stored to any depth and paid to exactly one: the tree is
     * free to keep and reconstructable later with a recursive query, while paying past the direct
     * referrer is a different decision with legal weight behind it, taken deliberately and not by
     * discovering the data was already there.
     *
     * First-touch and immutable — there is no UPDATE path in the application, and re-attribution is
     * how referral programmes get gamed by whoever asks last. The self-reference CHECK stops the
     * shortest cycle; longer ones are the engine's job, since Postgres cannot see them cheaply.
     */
    await queryRunner.query(`
      CREATE TABLE wallet.referrals (
        customer_id           TEXT PRIMARY KEY REFERENCES public.customer(id) ON DELETE RESTRICT,
        referred_by_customer_id TEXT NOT NULL REFERENCES public.customer(id) ON DELETE RESTRICT,
        brand                 VARCHAR(16) NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT wallet_referrals_brand_ck CHECK (brand IN ('crossfriend', 'pranajiva')),
        CONSTRAINT wallet_referrals_not_self_ck CHECK (customer_id <> referred_by_customer_id)
      );

      CREATE INDEX wallet_referrals_by_referrer
        ON wallet.referrals (referred_by_customer_id);
    `)

    await queryRunner.query(`
      CREATE TRIGGER wallet_referrals_append_only
        BEFORE UPDATE OR DELETE ON wallet.referrals
        FOR EACH ROW EXECUTE FUNCTION wallet.refuse_mutation();
    `)
  }

  /**
   * Drops the schema whole. Safe only because nothing writes to it until the grant engine ships —
   * once real balances exist, reversing this migration destroys money customers were promised, and
   * the correct move is a forward migration instead.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS wallet.allocations;`)
    await queryRunner.query(`DROP TABLE IF EXISTS wallet.referrals;`)
    await queryRunner.query(`DROP TABLE IF EXISTS wallet.entries;`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS wallet.refuse_mutation();`)
    await queryRunner.query(`DROP SCHEMA IF EXISTS wallet;`)
  }
}
