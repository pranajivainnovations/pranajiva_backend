/**
 * The `meta` schema: every Meta integration (Instagram now; Facebook Pages and WhatsApp next) and
 * its automation, kept apart from the shop's own tables.
 *
 * Used by migration 1729400000000-CreateMetaIntegrations. The manual .sql next to that migration is
 * generated from this string; change this file and regenerate it, never the .sql alone.
 *
 * ── Layout ───────────────────────────────────────────────────────────────────────────────────
 *   workspaces           a brand or a SaaS tenant ('pranajiva'). Everything below belongs to one.
 *   accounts             a connected Instagram account, Facebook Page or WhatsApp number.
 *                        An Instagram account points at its Page (linked_account_id): the Page is
 *                        what sends DMs, and is itself an account Facebook automation can use later.
 *   credentials          sealed tokens, one active per account and kind; rotated, never overwritten.
 *   media                posts and reels — the context the AI reads, plus an operator note.
 *   response_templates   saved replies, reusable across the inbox and conversations.
 *   campaigns            what to do, where, how often, until when.
 *     campaign_triggers  when it fires — several per campaign, any one is enough (keyword OR intent).
 *     campaign_actions   what it does — DM, public reply, hide — each with message versions.
 *   comments             the comment inbox, with the AI's reading of each comment.
 *   conversations        DM threads, one per account and person, with the 24-hour window.
 *   messages             every DM in and out.
 *   response_queue       everything we send — DMs, replies, hides, messages — the queue and its history.
 *   webhook_events       raw deliveries (14 days): "did Meta send it?"
 *   execution_logs       what the automation decided and did, step by step (90 days): "why?"
 *   analytics_daily      one row per account, campaign and day — kept after the detail is purged.
 *
 * External ids are VARCHAR: Meta ids exceed bigint range in places and are never arithmetic.
 */
export const META_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS meta;

CREATE TABLE meta.workspaces (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_workspaces_id_ck CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,63}$')
);
INSERT INTO meta.workspaces (id, name) VALUES ('pranajiva', 'PranaJiva');

CREATE TABLE meta.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id VARCHAR(64) NOT NULL REFERENCES meta.workspaces(id),
  platform VARCHAR(16) NOT NULL,
  external_id VARCHAR(64) NOT NULL,
  username VARCHAR(255),
  display_name VARCHAR(255),
  linked_account_id UUID REFERENCES meta.accounts(id) ON DELETE SET NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  webhook_subscribed BOOLEAN NOT NULL DEFAULT FALSE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  last_checked_at TIMESTAMPTZ,
  connected_by VARCHAR(64),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_accounts_platform_ck CHECK (platform IN ('instagram', 'facebook', 'whatsapp')),
  CONSTRAINT meta_accounts_status_ck CHECK (status IN ('active', 'expired', 'disconnected'))
);
/* One Instagram account / Page / number is connected once, by one workspace. */
CREATE UNIQUE INDEX uq_meta_accounts_external ON meta.accounts (platform, external_id);
CREATE INDEX idx_meta_accounts_workspace ON meta.accounts (workspace_id, platform, status);

CREATE TABLE meta.credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  kind VARCHAR(24) NOT NULL,
  sealed TEXT NOT NULL,
  last4 VARCHAR(8),
  scopes TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT meta_credentials_kind_ck CHECK (kind IN ('system_user_token', 'page_token', 'user_token', 'whatsapp_token'))
);
CREATE UNIQUE INDEX uq_meta_credentials_active ON meta.credentials (account_id, kind) WHERE revoked_at IS NULL;

CREATE TABLE meta.media (
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  external_id VARCHAR(64) NOT NULL,
  caption TEXT,
  permalink TEXT,
  media_type VARCHAR(32),
  product_type VARCHAR(32),
  thumbnail_url TEXT,
  posted_at TIMESTAMPTZ,
  notes TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, external_id)
);
CREATE INDEX idx_meta_media_recent ON meta.media (account_id, posted_at DESC);

CREATE TABLE meta.response_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id VARCHAR(64) NOT NULL REFERENCES meta.workspaces(id),
  name VARCHAR(120) NOT NULL,
  channel VARCHAR(8) NOT NULL DEFAULT 'any',
  body TEXT NOT NULL,
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT meta_templates_channel_ck CHECK (channel IN ('reply', 'dm', 'any')),
  CONSTRAINT meta_templates_body_ck CHECK (char_length(body) BETWEEN 1 AND 900)
);
CREATE INDEX idx_meta_templates_workspace ON meta.response_templates (workspace_id) WHERE archived_at IS NULL;

CREATE TABLE meta.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'paused',
  media_ids TEXT[],
  link_url TEXT,
  resource_name VARCHAR(160),
  once_per_person BOOLEAN NOT NULL DEFAULT TRUE,
  daily_dm_cap INTEGER NOT NULL DEFAULT 500,
  priority INTEGER NOT NULL DEFAULT 100,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_campaigns_status_ck CHECK (status IN ('active', 'paused', 'archived')),
  CONSTRAINT meta_campaigns_window_ck CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX idx_meta_campaigns_account ON meta.campaigns (account_id, status, priority);

CREATE TABLE meta.campaign_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES meta.campaigns(id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL,
  match_mode VARCHAR(16) NOT NULL DEFAULT 'word',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  intent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_triggers_kind_ck CHECK (kind IN ('keyword', 'intent', 'any_comment')),
  CONSTRAINT meta_triggers_match_ck CHECK (match_mode IN ('exact', 'word', 'contains')),
  CONSTRAINT meta_triggers_keyword_ck CHECK (kind <> 'keyword' OR cardinality(keywords) >= 1),
  CONSTRAINT meta_triggers_intent_ck CHECK (kind <> 'intent' OR char_length(coalesce(intent, '')) >= 3)
);
CREATE UNIQUE INDEX uq_meta_triggers_kind ON meta.campaign_triggers (campaign_id, kind);

CREATE TABLE meta.campaign_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES meta.campaigns(id) ON DELETE CASCADE,
  kind VARCHAR(8) NOT NULL,
  position SMALLINT NOT NULL DEFAULT 1,
  texts TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_actions_kind_ck CHECK (kind IN ('dm', 'reply', 'hide')),
  CONSTRAINT meta_actions_texts_ck CHECK (kind = 'hide' OR cardinality(texts) >= 1)
);
CREATE UNIQUE INDEX uq_meta_actions_kind ON meta.campaign_actions (campaign_id, kind);

CREATE TABLE meta.comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  comment_id VARCHAR(64) NOT NULL,
  media_id VARCHAR(64),
  parent_id VARCHAR(64),
  commenter_id VARCHAR(64) NOT NULL,
  commenter_username VARCHAR(255),
  text TEXT NOT NULL DEFAULT '',
  commented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  campaign_id UUID REFERENCES meta.campaigns(id) ON DELETE SET NULL,
  matched_by VARCHAR(24),
  note TEXT,
  ai_status VARCHAR(12) NOT NULL DEFAULT 'none',
  ai_attempts SMALLINT NOT NULL DEFAULT 0,
  ai_category VARCHAR(24),
  ai_sentiment VARCHAR(12),
  ai_risk VARCHAR(8),
  ai_language VARCHAR(12),
  ai_needs_human BOOLEAN,
  ai_reason TEXT,
  ai_draft TEXT,
  ai_model VARCHAR(64),
  ai_at TIMESTAMPTZ,
  handled_by VARCHAR(64),
  handled_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_comments_status_ck CHECK (status IN
    ('new', 'campaign', 'awaiting_approval', 'needs_human', 'replied', 'dismissed', 'hidden', 'spam')),
  CONSTRAINT meta_comments_ai_ck CHECK (ai_status IN ('none', 'pending', 'running', 'done', 'failed', 'skipped'))
);
CREATE UNIQUE INDEX uq_meta_comments ON meta.comments (account_id, comment_id);
CREATE INDEX idx_meta_comments_inbox ON meta.comments (account_id, status, received_at DESC);
CREATE INDEX idx_meta_comments_ai ON meta.comments (received_at) WHERE ai_status = 'pending';
CREATE INDEX idx_meta_comments_campaign ON meta.comments (campaign_id, commenter_id);
CREATE INDEX idx_meta_comments_media ON meta.comments (account_id, media_id);

CREATE TABLE meta.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  participant_id VARCHAR(64) NOT NULL,
  participant_username VARCHAR(255),
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_conversations_status_ck CHECK (status IN ('open', 'closed'))
);
CREATE UNIQUE INDEX uq_meta_conversations ON meta.conversations (account_id, participant_id);
CREATE INDEX idx_meta_conversations_recent ON meta.conversations (account_id, last_message_at DESC);

CREATE TABLE meta.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES meta.conversations(id) ON DELETE CASCADE,
  direction VARCHAR(4) NOT NULL,
  external_id VARCHAR(255),
  text TEXT,
  attachments JSONB,
  source VARCHAR(16) NOT NULL,
  comment_row_id UUID REFERENCES meta.comments(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_messages_direction_ck CHECK (direction IN ('in', 'out')),
  CONSTRAINT meta_messages_source_ck CHECK (source IN ('user', 'campaign', 'manual', 'ai_approved', 'ai_auto', 'echo'))
);
/* Meta redelivers, and our own sends come back as echoes: one row per message id. */
CREATE UNIQUE INDEX uq_meta_messages_external ON meta.messages (account_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_meta_messages_thread ON meta.messages (conversation_id, sent_at);

CREATE TABLE meta.response_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  kind VARCHAR(8) NOT NULL,
  source VARCHAR(16) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  comment_row_id UUID REFERENCES meta.comments(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES meta.conversations(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES meta.campaigns(id) ON DELETE SET NULL,
  text TEXT,
  status VARCHAR(12) NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  external_id VARCHAR(255),
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_queue_kind_ck CHECK (kind IN ('dm', 'reply', 'hide', 'message')),
  CONSTRAINT meta_queue_source_ck CHECK (source IN ('campaign', 'manual', 'ai_approved', 'ai_auto', 'moderation')),
  CONSTRAINT meta_queue_status_ck CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  CONSTRAINT meta_queue_target_ck CHECK ((kind = 'message') = (conversation_id IS NOT NULL))
);
/* One DM, one public reply and one hide per comment: Meta allows one private reply per comment, and
   a redelivered webhook or a double click must never become a second message. */
CREATE UNIQUE INDEX uq_meta_queue_once ON meta.response_queue (account_id, target_id, kind) WHERE kind IN ('dm', 'reply', 'hide');
CREATE INDEX idx_meta_queue_due ON meta.response_queue (next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_meta_queue_campaign ON meta.response_queue (campaign_id, kind, created_at);
CREATE INDEX idx_meta_queue_recent ON meta.response_queue (account_id, created_at DESC);
CREATE INDEX idx_meta_queue_comment ON meta.response_queue (comment_row_id);

CREATE TABLE meta.webhook_events (
  id BIGSERIAL PRIMARY KEY,
  platform VARCHAR(16) NOT NULL,
  account_external_id VARCHAR(64),
  field VARCHAR(32),
  outcome VARCHAR(32) NOT NULL,
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_meta_events_recent ON meta.webhook_events (account_external_id, received_at DESC);

CREATE TABLE meta.execution_logs (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  campaign_id UUID,
  comment_row_id UUID,
  queue_id UUID,
  step VARCHAR(32) NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_meta_logs_account ON meta.execution_logs (account_id, created_at DESC);
CREATE INDEX idx_meta_logs_campaign ON meta.execution_logs (campaign_id, created_at DESC) WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_meta_logs_comment ON meta.execution_logs (comment_row_id) WHERE comment_row_id IS NOT NULL;

/* campaign_id is the nil uuid for the account-wide row, so it can sit in the primary key. */
CREATE TABLE meta.analytics_daily (
  account_id UUID NOT NULL REFERENCES meta.accounts(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  day DATE NOT NULL,
  comments INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  dms_sent INTEGER NOT NULL DEFAULT 0,
  replies_sent INTEGER NOT NULL DEFAULT 0,
  auto_replies INTEGER NOT NULL DEFAULT 0,
  messages_in INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  ai_reads INTEGER NOT NULL DEFAULT 0,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, campaign_id, day)
);
`
