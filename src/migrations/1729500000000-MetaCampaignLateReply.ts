import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Campaigns get a fourth kind of action, `late`: the public reply for comments too old for a DM
 * (Instagram allows a private reply only within 7 days of the comment). It invites the person to
 * message the keyword instead, and the DM keyword automation answers them there.
 *
 * Only the CHECK constraint changes; no data is touched.
 */
export class MetaCampaignLateReply1729500000000 implements MigrationInterface {
  name = "MetaCampaignLateReply1729500000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE meta.campaign_actions DROP CONSTRAINT meta_actions_kind_ck;
      ALTER TABLE meta.campaign_actions ADD CONSTRAINT meta_actions_kind_ck CHECK (kind IN ('dm', 'reply', 'hide', 'late'));
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM meta.campaign_actions WHERE kind = 'late';
      ALTER TABLE meta.campaign_actions DROP CONSTRAINT meta_actions_kind_ck;
      ALTER TABLE meta.campaign_actions ADD CONSTRAINT meta_actions_kind_ck CHECK (kind IN ('dm', 'reply', 'hide'));
    `)
  }
}
