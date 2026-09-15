import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The reward configuration — GS-3.1.
 *
 * ── Versioned, never mutated ───────────────────────────────────────────────────────────────────
 * A rate is not a setting; it is a term of an agreement already struck with a customer. Cutting
 * referral from 5% to 3% must leave yesterday's referrals paying 5%, and "why did this customer get
 * ₹40?" has to stay answerable a year later. An UPDATE destroys both. So a change inserts a new row
 * with a later `effective_from`, the reward engine stamps the version it read onto every entry it
 * writes, and the two together mean the arithmetic behind any past payment can always be
 * reconstructed.
 *
 * The append-only trigger from the ledger migration is reused here for the same reason it exists
 * there: a convention that says "insert, don't update" survives until the first 2am incident.
 *
 * ── One table, four mechanics ──────────────────────────────────────────────────────────────────
 * Joining cash, referral and cashback share every structural property — they are scoped, they are
 * bounded by the same four limiters, and they are versioned identically. Giving each its own table
 * would triple the versioning logic so that three sets of nearly identical columns could drift
 * apart. `economics` rides the same machinery because gross margin and the redemption cap are
 * versioned facts too, and the guardrail that compares them to a proposed rate wants to read one
 * thing, not two.
 *
 * ── Why the rates live in JSONB ────────────────────────────────────────────────────────────────
 * Because the shape belongs in code. This codebase already draws that line — `settings/fields.ts`
 * declares which settings exist and what they mean, while the database holds only values — and the
 * same split applies here with more force: the parameters each mechanic needs are still being
 * discovered, and typed columns would mean a migration every time one is added for a mechanic that
 * has not been built yet. The write path validates against a catalogue in code, which doubles as
 * the whitelist, so a typo cannot quietly create a parameter nothing reads.
 *
 * The four limiters are typed columns rather than JSONB, because they are universal, the evaluator
 * filters on them, and a budget that is a string in one row and a number in another is a bug that
 * only shows up when the budget binds.
 *
 * ── Money is integers ──────────────────────────────────────────────────────────────────────────
 * Amounts in paise, rates in basis points: 500 bps is 5%, 1500 bps is the 15% redemption cap. No
 * percentage is ever stored as a float, because 0.05 is not 0.05 and a cap that is fractionally
 * above the margin instead of below it is the exact failure this system is built to prevent.
 */
export class CreateRewardConfig1725500000000 implements MigrationInterface {
  name = "CreateRewardConfig1725500000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallet.reward_config (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        brand         VARCHAR(16) NOT NULL,

        /* NULL is the brand default. A pincode row overrides it field by field — it does not
           replace it, so a launch offer can set a budget and an end date locally while the rate
           keeps coming from one place that moves every pincode at once. */
        pincode       VARCHAR(6),

        mechanic      VARCHAR(24) NOT NULL,

        /* Sequential within a scope, so "version 3 of referral in 201016" names one row for a human
           reading an audit log. effective_from is what the resolver actually orders by. */
        version       INTEGER NOT NULL,
        effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        /* The operator switch. Separate from the four limiters below and overriding them, because a
           deliberate stop and an automatic budget pause are different events and must not look the
           same in an audit log. */
        is_enabled    BOOLEAN NOT NULL DEFAULT FALSE,

        /* The four limiters. The first is the row's own scope; these are the other three. */
        starts_at     TIMESTAMPTZ,
        ends_at       TIMESTAMPTZ,
        max_grants    INTEGER,
        budget_paise  BIGINT,

        /* Mechanic-specific rates and amounts, validated in code against the field catalogue. */
        params        JSONB NOT NULL DEFAULT '{}'::jsonb,

        /* Why this version exists. Not decoration: the row it replaces is still there, and the only
           thing that explains the difference between them is somebody's sentence. */
        note          TEXT,

        created_by    UUID REFERENCES baker_network.ops_users(id) ON DELETE RESTRICT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(`
      ALTER TABLE wallet.reward_config
        ADD CONSTRAINT reward_config_brand_ck CHECK (brand IN ('crossfriend', 'pranajiva')),

        ADD CONSTRAINT reward_config_mechanic_ck CHECK (
          mechanic IN ('economics', 'joining_cash', 'referral', 'cashback')
        ),

        ADD CONSTRAINT reward_config_version_ck CHECK (version >= 1),

        /* A six-digit Indian pincode or nothing. An empty string would be a third meaning for a
           column that already has exactly two. */
        ADD CONSTRAINT reward_config_pincode_ck CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),

        /**
         * Economics is brand-level and has no limiters.
         *
         * Gross margin and the redemption cap describe the business, not an offer: they cannot be
         * switched on, they cannot run out of budget, and they do not end on the 31st. Letting them
         * carry those columns would invite someone to set a budget on the margin.
         */
        ADD CONSTRAINT reward_config_economics_ck CHECK (
          mechanic <> 'economics'
          OR (pincode IS NULL AND starts_at IS NULL AND ends_at IS NULL
              AND max_grants IS NULL AND budget_paise IS NULL)
        ),

        /* Zero is not a limit, it is a mechanic that can never fire — which is what is_enabled is
           for, and saying it twice in two different ways is how they come to disagree. */
        ADD CONSTRAINT reward_config_max_grants_ck CHECK (max_grants IS NULL OR max_grants > 0),
        ADD CONSTRAINT reward_config_budget_ck CHECK (budget_paise IS NULL OR budget_paise > 0),

        ADD CONSTRAINT reward_config_window_ck CHECK (
          starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
        ),

        ADD CONSTRAINT reward_config_params_ck CHECK (jsonb_typeof(params) = 'object');
    `)

    /**
     * One version number per scope.
     *
     * NULLS NOT DISTINCT is the point: without it Postgres treats every brand-default row as
     * unique regardless of version, because its pincode is NULL — and the table would happily
     * accept two "version 2" defaults for CrossFriend referral, which is precisely the ambiguity
     * versioning exists to remove.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX reward_config_scope_version
        ON wallet.reward_config (brand, pincode, mechanic, version) NULLS NOT DISTINCT;
    `)

    /* The resolver's access path: newest version at or before a moment, for one scope. */
    await queryRunner.query(`
      CREATE INDEX reward_config_effective
        ON wallet.reward_config (brand, mechanic, pincode, effective_from DESC) NULLS NOT DISTINCT;
    `)

    await queryRunner.query(`
      CREATE TRIGGER reward_config_append_only
        BEFORE UPDATE OR DELETE ON wallet.reward_config
        FOR EACH ROW EXECUTE FUNCTION wallet.refuse_mutation();
    `)

    /**
     * Seeded economics, so the guardrail has something to refuse against from the first day.
     *
     * Both figures are placeholders and say so in their note. The margins are the spec's working
     * assumptions — CrossFriend ~20% because real cash goes to a baker on every order, PranaJiva 50%+
     * on own-brand goods — and the caps are set below them, which is the one relationship that must
     * hold: a redemption cap at or above gross margin means every fully-discounted order loses money
     * by construction.
     *
     * Seeded rather than left empty precisely because they are wrong. An absent margin makes the
     * guardrail fall open the first time someone configures an offer; a visibly provisional one
     * makes it refuse, and puts the real number on somebody's list.
     */
    await queryRunner.query(`
      INSERT INTO wallet.reward_config (brand, mechanic, version, is_enabled, params, note) VALUES
        (
          'crossfriend', 'economics', 1, TRUE,
          '{"gross_margin_bps": 2000, "promo_redemption_cap_bps": 1500}'::jsonb,
          'PLACEHOLDER — 20% margin and a 15% cap are the spec''s working assumptions, not measured figures. Replace with real AOV-weighted margin before any offer goes live.'
        ),
        (
          'pranajiva', 'economics', 1, TRUE,
          '{"gross_margin_bps": 5000, "promo_redemption_cap_bps": 3500}'::jsonb,
          'PLACEHOLDER — 50% margin and a 35% cap are the spec''s working assumptions, not measured figures. Own-brand goods absorb more credit than a marketplace order can.'
        );
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS wallet.reward_config;`)
  }
}
