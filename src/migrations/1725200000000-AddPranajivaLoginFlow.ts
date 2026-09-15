import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The Pranajiva sign-in flow — GS-1.1 of the growth system build.
 *
 * ── Why this is a seed row and not a schema change ─────────────────────────────────────────────
 * The growth spec called for making `message_flows` "brand-aware", which sounded like a migration
 * that adds a brand column. It is not: `flow_key` is already the primary key and `otp_attempts` is
 * already keyed by flow, so every per-flow limit — TTL, attempt cap, resend cooldown, daily send
 * limit — is per-brand the moment a second flow row exists. A brand column would add a second way
 * to express the same fact and let the two disagree.
 *
 * The one thing brand-awareness genuinely needs in code is the OTP send route, which today only
 * accepts `ai_studio_login`. That is GS-1.2, deliberately separate: this migration is additive and
 * inert, so it can be applied well before the route or the Pranajiva login screen exist.
 *
 * ── Why it is seeded DISABLED ──────────────────────────────────────────────────────────────────
 * Assigning the template is a statement of fact — the PRANAJ registration exists and is active.
 * Enabling the flow is an operational decision, and this row would otherwise become sendable
 * before there is any legitimate caller: a flow that is on but unreachable is indistinguishable
 * from one that is broken. It also matches the rule the whole growth system is built on — every
 * mechanic starts and stops from OPS, never from a deploy. OPS flips this on when GS-1.4 ships the
 * Pranajiva login screen.
 *
 * ── Why the template is matched by sender header, not by id ────────────────────────────────────
 * The primary key of `sms_templates` is a per-environment UUID, so hardcoding the production value
 * would silently produce an unassigned flow anywhere else. The DLT template id is stable and
 * uniquely indexed, which makes it the obvious alternative, but it is the identifier of our TRAI
 * registration and the parent migration deliberately keeps those out of source control — the
 * templates themselves were entered through OPS for that reason. The sender header is printed on
 * every message the brand has ever sent, so it carries no secret, and "the active template
 * registered under PRANAJ" is exactly the human intent. Where no such template exists the subselect
 * yields NULL, the flow stays unassigned, and `flowBlockedReason` reports it as not configured —
 * which is the correct outcome, not a failure to recover from.
 */
export class AddPranajivaLoginFlow1725200000000 implements MigrationInterface {
  name = "AddPranajivaLoginFlow1725200000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * `otp_ttl_seconds` is 600 rather than the column's 300 default because both registered SMS
     * bodies say "Valid for 10 minutes". A 5-minute TTL would make the message the customer holds
     * in their hand untrue, and the DLT body cannot be edited without re-registering. The remaining
     * policy numbers match the CrossFriend flow so the two brands behave identically under abuse.
     *
     * ON CONFLICT DO NOTHING because OPS owns every column here once the row exists — the label on
     * the CrossFriend flow has already been edited away from what its migration seeded. A migration
     * that re-ran and overwrote operator changes would be a worse failure than one that did nothing.
     */
    await queryRunner.query(`
      INSERT INTO crossfriend.message_flows (
        flow_key, label, description, template_id,
        otp_length, otp_ttl_seconds, max_attempts, resend_cooldown_seconds, daily_send_limit,
        is_enabled
      )
      SELECT
        'pranajiva_login',
        'PranaJiva — sign in',
        'One-time password sent when a customer signs in to PranaJiva with their mobile number.',
        (
          SELECT t.id FROM crossfriend.sms_templates t
           WHERE t.sender_header = 'PRANAJ' AND t.is_active
           ORDER BY t.created_at
           LIMIT 1
        ),
        6, 600, 5, 30, 10,
        FALSE
      ON CONFLICT (flow_key) DO NOTHING;
    `)
  }

  /**
   * Removing the row is safe: nothing holds a foreign key to `message_flows`. `otp_attempts.flow_key`
   * is a loose reference by design, so historic send and verify attempts survive this and stay
   * auditable — which is what you want, since deleting a flow must not erase the record of the
   * messages it sent.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM crossfriend.message_flows WHERE flow_key = 'pranajiva_login';
    `)
  }
}
