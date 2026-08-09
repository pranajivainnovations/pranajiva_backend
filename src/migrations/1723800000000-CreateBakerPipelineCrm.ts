import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Turns the baker pipeline from a status dropdown into a record of what actually happened.
 *
 * Before this, everything an ops person learned in a conversation went into `bakers.notes` —
 * ONE text column, overwritten on every save, with no author, no date, and no history. Two
 * people editing the same baker silently destroyed each other's work. `status_updated_at` held
 * only the most recent transition, so "how long has this prospect been stuck?" was unanswerable.
 *
 * Four tables, all one-to-many off `bakers`, all unbounded — a baker can accumulate any number
 * of contacts, conversations and appointments over any length of courtship:
 *
 *   baker_contacts      the people (owner, manager, the brother who actually answers the phone)
 *   baker_interactions  the timeline — every call, visit, WhatsApp and standalone note
 *   baker_appointments  commitments with their own lifecycle, independent of any conversation
 *   baker_stage_history every pipeline transition, with who and why
 *
 * Notes deliberately live INSIDE baker_interactions as kind='note' rather than in their own
 * table. Ops needs one chronological story per baker; a parallel notes list would mean reading
 * two feeds side by side to reconstruct what happened.
 */
export class CreateBakerPipelineCrm1723800000000 implements MigrationInterface {
  name = "CreateBakerPipelineCrm1723800000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- contacts
    // `bakers` has a single contact_person/phone/email. That models a business with exactly one
    // reachable human, which is not how bakeries work — the owner's number reaches a shop
    // landline, and the person who actually decides is on WhatsApp under a different name.
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,

        name TEXT NOT NULL,
        role TEXT,
        phone VARCHAR(20),
        whatsapp_number VARCHAR(20),
        email VARCHAR(255),
        notes TEXT,

        is_primary BOOLEAN NOT NULL DEFAULT false,
        -- Contacts are retired, never deleted: a past conversation must keep pointing at the
        -- person who had it, even after they leave the bakery.
        is_active BOOLEAN NOT NULL DEFAULT true,

        created_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(
      `CREATE INDEX idx_baker_contacts_baker ON baker_network.baker_contacts(baker_id);`
    )
    // At most one primary per baker, enforced by the database rather than by whichever code path
    // happens to remember. Partial index, so any number of non-primary contacts coexist.
    await queryRunner.query(
      `CREATE UNIQUE INDEX idx_baker_contacts_one_primary
         ON baker_network.baker_contacts(baker_id) WHERE is_primary;`
    )

    // ------------------------------------------------------------ interactions
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_interactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,

        kind VARCHAR(20) NOT NULL DEFAULT 'note'
          CHECK (kind IN ('note', 'call', 'whatsapp', 'email', 'visit', 'meeting', 'other')),

        -- The stage the baker was in WHEN this happened, frozen at write time. Without it, a
        -- timeline read six months later shows every past conversation under today's stage, and
        -- you lose the ability to see what was actually said while negotiating.
        stage_at_time VARCHAR(20),

        -- Separate from created_at: ops logs Tuesday's call on Thursday. occurred_at orders the
        -- story, created_at records when it was written down.
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        summary TEXT NOT NULL,
        outcome VARCHAR(20)
          CHECK (outcome IN ('positive', 'neutral', 'negative', 'no_response')),

        contact_id UUID REFERENCES baker_network.baker_contacts(id) ON DELETE SET NULL,

        created_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(
      `CREATE INDEX idx_baker_interactions_timeline
         ON baker_network.baker_interactions(baker_id, occurred_at DESC);`
    )

    // ------------------------------------------------------------ appointments
    // Their own table, not a next_action_due column on an interaction. A follow-up field caps you
    // at one commitment per conversation and cannot represent an appointment booked before any
    // conversation has happened — both of which are ordinary.
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,
        contact_id UUID REFERENCES baker_network.baker_contacts(id) ON DELETE SET NULL,

        scheduled_for TIMESTAMPTZ NOT NULL,
        channel VARCHAR(20) NOT NULL DEFAULT 'call'
          CHECK (channel IN ('call', 'whatsapp', 'email', 'visit', 'meeting', 'other')),
        purpose TEXT NOT NULL,
        location TEXT,

        status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
          CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),

        -- Closes the loop: completing an appointment writes the interaction describing how it
        -- went, and the appointment points at it. 'no_show' is kept distinct from 'cancelled'
        -- because a baker who twice fails to appear is telling you something a cancellation isn't.
        outcome_interaction_id UUID
          REFERENCES baker_network.baker_interactions(id) ON DELETE SET NULL,

        assigned_to UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        created_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(
      `CREATE INDEX idx_baker_appointments_baker ON baker_network.baker_appointments(baker_id);`
    )
    // Drives the "what is due, and what did we miss" view across every baker at once.
    await queryRunner.query(
      `CREATE INDEX idx_baker_appointments_due
         ON baker_network.baker_appointments(status, scheduled_for);`
    )

    // ----------------------------------------------------------- stage history
    await queryRunner.query(`
      CREATE TABLE baker_network.baker_stage_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        baker_id UUID NOT NULL REFERENCES baker_network.bakers(id) ON DELETE CASCADE,

        from_stage VARCHAR(20),
        to_stage VARCHAR(20) NOT NULL,
        reason TEXT,

        changed_by UUID REFERENCES baker_network.ops_users(id) ON DELETE SET NULL,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    await queryRunner.query(
      `CREATE INDEX idx_baker_stage_history_baker
         ON baker_network.baker_stage_history(baker_id, changed_at);`
    )

    // --------------------------------------------------------------- on bakers
    await queryRunner.query(`
      ALTER TABLE baker_network.bakers
        -- Coarse on purpose. A 0-100 slider produces a column where everything is 50 or 80,
        -- because nobody can defend 65 over 70. Three buckets stay honest, and the useful signal
        -- is the pair: high confidence AND not contacted in three weeks is the row to act on.
        ADD COLUMN confidence VARCHAR(10)
          CHECK (confidence IN ('high', 'medium', 'low')),
        -- Denormalised from baker_interactions so the pipeline board can sort every baker by
        -- staleness without a correlated subquery per card. Written by the same action that
        -- inserts an interaction.
        ADD COLUMN last_contacted_at TIMESTAMPTZ;
    `)

    // Seed history so no baker has an empty timeline: record the stage they are in today, dated
    // from their existing status_updated_at (or creation). Without this, every existing baker
    // reads as "never moved", which is false.
    await queryRunner.query(`
      INSERT INTO baker_network.baker_stage_history (baker_id, from_stage, to_stage, reason, changed_at)
      SELECT id, NULL, status, 'Recorded when pipeline tracking was introduced',
             COALESCE(status_updated_at, created_at, NOW())
      FROM baker_network.bakers;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE baker_network.bakers
        DROP COLUMN IF EXISTS confidence,
        DROP COLUMN IF EXISTS last_contacted_at;
    `)
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_stage_history;`)
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_appointments;`)
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_interactions;`)
    await queryRunner.query(`DROP TABLE IF EXISTS baker_network.baker_contacts;`)
  }
}
