-- CRM Micro Fácil — esquema inicial
-- Todas as datas/horas são armazenadas em timestamptz (UTC) e exibidas em America/Sao_Paulo.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Equipes, usuários, sessões
-- ============================================================
CREATE TABLE teams (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text NOT NULL,
  email            text NOT NULL,
  password_hash    text NOT NULL,
  role             text NOT NULL CHECK (role IN ('admin','manager','seller')),
  team_id          bigint REFERENCES teams(id) ON DELETE SET NULL,
  phone            text,
  active           boolean NOT NULL DEFAULT true,
  receives_leads   boolean NOT NULL DEFAULT false,
  max_open_leads   integer,
  failed_logins    integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  last_seen_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id           text PRIMARY KEY,            -- sha256 do token
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_resets (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE audit_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  entity_type  text,
  entity_id    bigint,
  changes      jsonb,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, created_at DESC);

-- ============================================================
-- Catálogo
-- ============================================================
CREATE TABLE course_categories (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courses (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                  text NOT NULL,
  code                  text UNIQUE,                 -- identificador usado por formulários/integrações
  kind                  text NOT NULL DEFAULT 'course' CHECK (kind IN ('course','formation','program')),
  category_id           bigint REFERENCES course_categories(id) ON DELETE SET NULL,
  description           text,
  modality              text,                        -- presencial, online, híbrido...
  workload_hours        integer,
  price                 numeric(12,2),
  promo_price           numeric(12,2),
  promo_until           date,
  commercial_conditions text,
  seller_notes          text,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courses_name_trgm ON courses USING gin (name gin_trgm_ops);

CREATE TABLE course_materials (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id   bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       text NOT NULL,
  url         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Campanhas e investimento
-- ============================================================
CREATE TABLE campaigns (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  utm_campaign  text,                 -- valor usado para casar leads pelo parâmetro UTM
  channel       text,                 -- meta_ads, google_ads, organico...
  external_id   text,                 -- id da campanha na plataforma (ex.: Meta)
  start_date    date,
  end_date      date,
  active        boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX campaigns_utm_uq ON campaigns (lower(utm_campaign)) WHERE utm_campaign IS NOT NULL;
CREATE UNIQUE INDEX campaigns_external_uq ON campaigns (channel, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE campaign_spend (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id  bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  day          date NOT NULL,
  amount       numeric(12,2) NOT NULL,
  impressions  bigint,
  clicks       bigint,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','meta_ads')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, day, source)
);

-- ============================================================
-- Etiquetas e campos personalizados
-- ============================================================
CREATE TABLE tags (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#64748b',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tags_name_uq ON tags (lower(name));

CREATE TABLE custom_fields (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL UNIQUE,
  label       text NOT NULL,
  type        text NOT NULL CHECK (type IN ('text','textarea','number','date','select','boolean')),
  options     jsonb NOT NULL DEFAULT '[]',
  required    boolean NOT NULL DEFAULT false,
  position    integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lost_reasons (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  position    integer NOT NULL DEFAULT 0
);

-- ============================================================
-- Leads
-- ============================================================
CREATE TABLE leads (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                 text NOT NULL,
  phone                text,                       -- E.164 somente dígitos (ex.: 5511999998888)
  email                text,                       -- minúsculo
  document             text,
  birth_date           date,
  city                 text,
  state                text,
  course_id            bigint REFERENCES courses(id) ON DELETE SET NULL,
  source               text,
  campaign_id          bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  utm_source           text,
  utm_medium           text,
  utm_campaign         text,
  utm_term             text,
  utm_content          text,
  referrer_url         text,
  external_ref         text,                       -- id do lead no sistema de origem
  owner_id             bigint REFERENCES users(id) ON DELETE SET NULL,
  assigned_at          timestamptz,
  status               text NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new','attempting','in_progress','qualified','customer','lost','unqualified')),
  custom               jsonb NOT NULL DEFAULT '{}',
  notes                text,
  consent_whatsapp     boolean NOT NULL DEFAULT false,
  consent_at           timestamptz,
  first_contact_at     timestamptz,
  last_interaction_at  timestamptz,
  last_inbound_at      timestamptz,
  last_outbound_at     timestamptz,
  reactivation_flag    boolean NOT NULL DEFAULT false,
  merged_into_id       bigint REFERENCES leads(id) ON DELETE SET NULL,
  created_by           bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE INDEX leads_phone_idx ON leads (phone) WHERE deleted_at IS NULL;
CREATE INDEX leads_email_idx ON leads (email) WHERE deleted_at IS NULL;
CREATE INDEX leads_owner_idx ON leads (owner_id, status) WHERE deleted_at IS NULL;
CREATE INDEX leads_created_idx ON leads (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX leads_status_idx ON leads (status) WHERE deleted_at IS NULL;
CREATE INDEX leads_course_idx ON leads (course_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_campaign_idx ON leads (campaign_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_last_interaction_idx ON leads (last_interaction_at) WHERE deleted_at IS NULL;
CREATE INDEX leads_name_trgm ON leads USING gin (name gin_trgm_ops);
CREATE INDEX leads_external_idx ON leads (source, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE lead_tags (
  lead_id  bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id   bigint NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);
CREATE INDEX lead_tags_tag_idx ON lead_tags (tag_id);

-- Linha do tempo: todas as interações, mudanças e eventos do lead
CREATE TABLE lead_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, created_at DESC);
CREATE INDEX lead_events_type_idx ON lead_events (type, created_at DESC);

-- Histórico de status comercial
CREATE TABLE lead_status_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id      bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_status_history_lead_idx ON lead_status_history (lead_id, created_at);

-- ============================================================
-- Funis e oportunidades
-- ============================================================
CREATE TABLE pipelines (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pipelines_default_uq ON pipelines (is_default) WHERE is_default;

CREATE TABLE pipeline_stages (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pipeline_id       bigint NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name              text NOT NULL,
  position          integer NOT NULL DEFAULT 0,
  kind              text NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  probability       integer NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  stale_after_days  integer,
  color             text NOT NULL DEFAULT '#64748b',
  archived          boolean NOT NULL DEFAULT false
);
CREATE INDEX pipeline_stages_pipeline_idx ON pipeline_stages (pipeline_id, position);

CREATE TABLE opportunities (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id              bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  pipeline_id          bigint NOT NULL REFERENCES pipelines(id),
  stage_id             bigint NOT NULL REFERENCES pipeline_stages(id),
  owner_id             bigint REFERENCES users(id) ON DELETE SET NULL,
  course_id            bigint REFERENCES courses(id) ON DELETE SET NULL,
  campaign_id          bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  source               text,
  title                text NOT NULL,
  value                numeric(12,2),                 -- valor previsto
  sale_value           numeric(12,2),                 -- valor efetivamente vendido
  expected_close_date  date,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  won_at               timestamptz,
  lost_at              timestamptz,
  lost_reason_id       bigint REFERENCES lost_reasons(id) ON DELETE SET NULL,
  lost_note            text,
  stage_entered_at     timestamptz NOT NULL DEFAULT now(),
  position             double precision NOT NULL DEFAULT 0,
  created_by           bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunities_lead_idx ON opportunities (lead_id);
CREATE INDEX opportunities_stage_idx ON opportunities (pipeline_id, stage_id, status);
CREATE INDEX opportunities_owner_idx ON opportunities (owner_id, status);
CREATE INDEX opportunities_won_idx ON opportunities (won_at) WHERE status = 'won';
CREATE INDEX opportunities_course_idx ON opportunities (course_id);

CREATE TABLE opportunity_stage_history (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id    bigint NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  from_stage_id     bigint REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id       bigint NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  seconds_in_prev   bigint,
  user_id           bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX osh_opportunity_idx ON opportunity_stage_history (opportunity_id, created_at);
CREATE INDEX osh_to_stage_idx ON opportunity_stage_history (to_stage_id, created_at);

-- ============================================================
-- Agenda / atividades
-- ============================================================
CREATE TABLE tasks (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type                      text NOT NULL DEFAULT 'task'
                              CHECK (type IN ('call','whatsapp','meeting','visit','task','followup','reminder','first_contact')),
  title                     text NOT NULL,
  description               text,
  lead_id                   bigint REFERENCES leads(id) ON DELETE CASCADE,
  opportunity_id            bigint REFERENCES opportunities(id) ON DELETE SET NULL,
  assignee_id               bigint REFERENCES users(id) ON DELETE SET NULL,
  created_by                bigint REFERENCES users(id) ON DELETE SET NULL,
  due_at                    timestamptz NOT NULL,
  duration_minutes          integer NOT NULL DEFAULT 30,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','canceled')),
  completed_at              timestamptz,
  outcome                   text,
  remind_minutes_before     integer NOT NULL DEFAULT 15,
  reminded_at               timestamptz,
  overdue_notified_at       timestamptz,
  reschedule_count          integer NOT NULL DEFAULT 0,
  source                    text NOT NULL DEFAULT 'manual',   -- manual | automation
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_assignee_due_idx ON tasks (assignee_id, status, due_at);
CREATE INDEX tasks_lead_idx ON tasks (lead_id);
CREATE INDEX tasks_due_pending_idx ON tasks (due_at) WHERE status = 'pending';

-- ============================================================
-- Notificações internas
-- ============================================================
CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);

-- ============================================================
-- WhatsApp
-- ============================================================
CREATE TABLE wa_accounts (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name               text NOT NULL,
  phone_number_id    text NOT NULL UNIQUE,
  waba_id            text NOT NULL,
  display_phone      text,
  verified_name      text,
  access_token_enc   text NOT NULL,
  coexistence        boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','error','disabled')),
  quality_rating     text,
  last_check_at      timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wa_account_id         bigint NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  lead_id               bigint REFERENCES leads(id) ON DELETE SET NULL,
  contact_wa_id         text NOT NULL,           -- número do cliente (wa_id)
  contact_name          text,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
  assignee_id           bigint REFERENCES users(id) ON DELETE SET NULL,
  unread_count          integer NOT NULL DEFAULT 0,
  awaiting_reply        boolean NOT NULL DEFAULT false,   -- última mensagem é do cliente
  awaiting_since        timestamptz,
  last_message_at       timestamptz,
  last_message_preview  text,
  last_inbound_at       timestamptz,                      -- base da janela de 24h
  first_response_at     timestamptz,
  closed_at             timestamptz,
  closed_by             bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wa_account_id, contact_wa_id)
);
CREATE INDEX conversations_lead_idx ON conversations (lead_id);
CREATE INDEX conversations_assignee_idx ON conversations (assignee_id, status, last_message_at DESC);
CREATE INDEX conversations_last_msg_idx ON conversations (last_message_at DESC);

CREATE TABLE conversation_tags (
  conversation_id  bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id           bigint NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);

-- Histórico de atendimentos (abertura/encerramento) para métricas
CREATE TABLE conversation_sessions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id    bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assignee_id        bigint REFERENCES users(id) ON DELETE SET NULL,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  first_response_at  timestamptz,
  closed_at          timestamptz
);
CREATE INDEX conversation_sessions_conv_idx ON conversation_sessions (conversation_id, opened_at DESC);
CREATE INDEX conversation_sessions_opened_idx ON conversation_sessions (opened_at);

CREATE TABLE messages (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id  bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('in','out','note')),
  wamid            text,                       -- id da mensagem na Meta
  type             text NOT NULL,              -- text, image, audio, video, document, sticker, location, contacts, interactive, button, reaction, template, unsupported, note
  body             text,
  media_id         text,
  media_mime       text,
  media_filename   text,
  media_path       text,
  media_size       bigint,
  media_status     text,                       -- pending | ready | failed
  template_name    text,
  status           text NOT NULL DEFAULT 'received',  -- queued, sent, delivered, read, failed, received, note
  error            jsonb,
  sender_id        bigint REFERENCES users(id) ON DELETE SET NULL,
  origin           text NOT NULL DEFAULT 'crm',       -- crm | phone_app (coexistência) | history | customer | automation
  reply_to_wamid   text,
  sent_at          timestamptz NOT NULL DEFAULT now(),  -- horário da mensagem (WhatsApp)
  status_at        timestamptz,
  raw              jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_wamid_uq ON messages (wamid) WHERE wamid IS NOT NULL;
CREATE INDEX messages_conv_idx ON messages (conversation_id, sent_at, id);
CREATE INDEX messages_body_trgm ON messages USING gin (body gin_trgm_ops);

CREATE TABLE quick_replies (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcut    text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  owner_id    bigint REFERENCES users(id) ON DELETE CASCADE,   -- NULL = compartilhada
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wa_templates (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wa_account_id  bigint NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  external_id    text,
  name           text NOT NULL,
  language       text NOT NULL,
  category       text,
  status         text NOT NULL,
  components     jsonb NOT NULL DEFAULT '[]',
  synced_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wa_account_id, name, language)
);

-- ============================================================
-- Integrações
-- ============================================================
CREATE TABLE integrations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type             text NOT NULL CHECK (type IN ('meta_app','meta_lead_ads','meta_ads_insights','inbound_webhook','outbound_webhook','smtp')),
  name             text NOT NULL,
  config           jsonb NOT NULL DEFAULT '{}',
  secrets_enc      text,
  token            text UNIQUE,                 -- token público de URL (webhooks de entrada)
  active           boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','error','disabled')),
  last_success_at  timestamptz,
  last_error_at    timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration     text NOT NULL,                 -- ex.: whatsapp:3, integration:5, api_key:2
  level           text NOT NULL CHECK (level IN ('info','warn','error')),
  action          text NOT NULL,
  message         text NOT NULL,
  data            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_logs_idx ON integration_logs (integration, created_at DESC);
CREATE INDEX integration_logs_created_idx ON integration_logs (created_at DESC);

CREATE TABLE api_keys (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text NOT NULL,
  prefix           text NOT NULL,
  key_hash         text NOT NULL UNIQUE,
  scopes           text[] NOT NULL DEFAULT ARRAY['leads:create'],
  allowed_origins  text[] NOT NULL DEFAULT '{}',
  default_source   text,
  default_course_id bigint REFERENCES courses(id) ON DELETE SET NULL,
  active           boolean NOT NULL DEFAULT true,
  last_used_at     timestamptz,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Eventos recebidos (webhooks) — persistidos antes de processar, base para deduplicação e reprocessamento
CREATE TABLE webhook_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider         text NOT NULL,              -- meta, inbound:<id>, api
  dedupe_key       text,
  signature_valid  boolean,
  headers          jsonb,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','failed','ignored')),
  attempts         integer NOT NULL DEFAULT 0,
  error            text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);
CREATE UNIQUE INDEX webhook_events_dedupe_uq ON webhook_events (provider, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX webhook_events_status_idx ON webhook_events (status, received_at);
CREATE INDEX webhook_events_received_idx ON webhook_events (received_at DESC);

-- Chaves de idempotência das APIs de captação
CREATE TABLE idempotency_keys (
  scope       text NOT NULL,
  key         text NOT NULL,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- ============================================================
-- Fila de tarefas em segundo plano (sem dependência de Redis)
-- ============================================================
CREATE TABLE jobs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 8,
  dedupe_key    text,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX jobs_pending_idx ON jobs (run_at) WHERE status = 'pending';
CREATE UNIQUE INDEX jobs_dedupe_uq ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

-- ============================================================
-- Automações
-- ============================================================
CREATE TABLE automation_rules (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  description   text,
  trigger       text NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}',
  conditions    jsonb NOT NULL DEFAULT '[]',
  actions       jsonb NOT NULL DEFAULT '[]',
  delay_minutes integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  position      integer NOT NULL DEFAULT 0,
  run_count     integer NOT NULL DEFAULT 0,
  fail_count    integer NOT NULL DEFAULT 0,
  last_run_at   timestamptz,
  created_by    bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id      bigint NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  entity_id    bigint NOT NULL,
  dedupe_key   text,
  status       text NOT NULL CHECK (status IN ('success','failed','skipped','partial')),
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_runs_rule_idx ON automation_runs (rule_id, created_at DESC);
CREATE UNIQUE INDEX automation_runs_dedupe_uq ON automation_runs (rule_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Webhooks de saída: notificam sistemas externos sobre eventos do CRM
CREATE TABLE outbound_deliveries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration_id  bigint NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  response_code   integer,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX outbound_deliveries_idx ON outbound_deliveries (integration_id, created_at DESC);
