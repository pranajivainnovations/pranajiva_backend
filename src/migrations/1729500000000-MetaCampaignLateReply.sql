-- Manual equivalent of 1729500000000-MetaCampaignLateReply.ts
--
-- Campaign actions gain the kind 'late': the public reply for comments too old for a DM.
-- The final INSERT registers it in TypeORM's ledger so `medusa migrations run` skips it.
--
-- To undo:
--   DELETE FROM meta.campaign_actions WHERE kind = 'late';
--   ALTER TABLE meta.campaign_actions DROP CONSTRAINT meta_actions_kind_ck;
--   ALTER TABLE meta.campaign_actions ADD CONSTRAINT meta_actions_kind_ck CHECK (kind IN ('dm', 'reply', 'hide'));
--   DELETE FROM migrations WHERE timestamp = 1729500000000;

BEGIN;

ALTER TABLE meta.campaign_actions DROP CONSTRAINT meta_actions_kind_ck;
ALTER TABLE meta.campaign_actions ADD CONSTRAINT meta_actions_kind_ck CHECK (kind IN ('dm', 'reply', 'hide', 'late'));

INSERT INTO migrations (timestamp, name) VALUES (1729500000000, 'MetaCampaignLateReply1729500000000');

COMMIT;
