-- ════════════════════════════════════════════════════════════════════════════
-- LEADS — the calling and follow-up side of the same `leads` table CRM uses.
--
-- A lead is one record whether it is worked in the Leads app or converted in
-- CRM. This adds what a calling team needs on it: the workspace's own fields,
-- stages, the next follow-up, and where the lead came from.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check CHECK (source IN (
  'manual', 'website', 'referral', 'campaign', 'event', 'cold_call', 'import', 'api', 'partner',
  'meta', 'google_sheet', 'survey', 'webhook', 'whatsapp', 'walk_in'));

ALTER TABLE leads
  -- Values for the workspace's own fields, keyed by lead_fields.key.
  ADD COLUMN custom            jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN stage_id          text,
  ADD COLUMN city              text,
  ADD COLUMN lost_reason       text,
  -- Kept in step with the earliest open follow-up, for sorting and filters.
  ADD COLUMN next_followup_at  timestamptz,
  ADD COLUMN last_call_at      timestamptz,
  ADD COLUMN last_call_outcome text,
  ADD COLUMN call_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN source_id         text,
  -- "Meta · Diwali offer form", "Sheet · Website enquiries", a CSV's name.
  ADD COLUMN source_detail     text,
  -- The lead's identity at its source (a Meta lead id, a sheet row), so a
  -- sync that runs twice never creates it twice.
  ADD COLUMN ext_key           text,
  -- The last ten digits: +91 98765 43210 and 09876543210 are one number.
  ADD COLUMN phone_key text GENERATED ALWAYS AS
    (NULLIF(right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10), '')) STORED;

CREATE UNIQUE INDEX leads_ext_key_key   ON leads (org_id, ext_key) WHERE ext_key IS NOT NULL;
CREATE INDEX leads_org_phone_idx        ON leads (org_id, phone_key) WHERE archived_at IS NULL AND phone_key IS NOT NULL;
CREATE INDEX leads_org_stage_idx        ON leads (org_id, stage_id) WHERE archived_at IS NULL;
CREATE INDEX leads_org_followup_idx     ON leads (org_id, owner_user_id, next_followup_at) WHERE archived_at IS NULL;

-- ── follow-ups and calls live on the shared activity timeline ──────────────
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_kind_check;
ALTER TABLE activities ADD CONSTRAINT activities_kind_check
  CHECK (kind IN ('call', 'meeting', 'email', 'task', 'note', 'whatsapp', 'visit', 'update'));

ALTER TABLE activities
  ADD COLUMN reminded_at timestamptz,
  -- A cancelled follow-up is also "completed", so CRM's open lists drop it.
  ADD COLUMN canceled_at timestamptz;

CREATE INDEX activities_reminder_idx ON activities (due_at)
  WHERE completed_at IS NULL AND reminded_at IS NULL AND due_at IS NOT NULL;

-- ── the workspace's own lead fields ────────────────────────────────────────
CREATE TABLE lead_fields (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  key           text NOT NULL,
  label         text NOT NULL,
  type          text NOT NULL CHECK (type IN
                  ('text', 'long_text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'phone', 'email', 'url')),
  options       jsonb NOT NULL DEFAULT '[]',
  required      boolean NOT NULL DEFAULT false,
  show_in_list  boolean NOT NULL DEFAULT false,
  position      integer NOT NULL DEFAULT 0,
  archived_at   timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);

-- ── stages a lead moves through ────────────────────────────────────────────
CREATE TABLE lead_stages (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT 'slate',
  kind        text NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost')),
  position    integer NOT NULL DEFAULT 0,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX lead_stages_name_key ON lead_stages (org_id, lower(name));

-- ── connected sources: Google Sheets, Meta lead ads, inbound webhooks ──────
CREATE TABLE lead_sources (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('google_sheet', 'meta', 'webhook')),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  -- google_sheet: { sheet_url }   meta: { page_id, page_name, form_ids[] }
  config          jsonb NOT NULL DEFAULT '{}',
  -- An access token, encrypted at rest (Meta). Never returned by the API.
  secret          text,
  -- The unguessable part of an inbound webhook URL.
  token           text,
  -- Incoming column/key → lead field (`first_name`, `custom.budget`, …).
  field_map       jsonb NOT NULL DEFAULT '{}',
  -- New leads are shared round-robin among these people (empty: unassigned).
  assign_to       text[] NOT NULL DEFAULT '{}',
  assign_cursor   integer NOT NULL DEFAULT 0,
  stage_id        text,
  tags            text[] NOT NULL DEFAULT '{}',
  auto_sync       boolean NOT NULL DEFAULT true,
  sync_cursor     jsonb NOT NULL DEFAULT '{}',
  last_synced_at  timestamptz,
  syncing_at      timestamptz,
  last_error      text,
  lead_count      integer NOT NULL DEFAULT 0,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX lead_sources_token_key ON lead_sources (token) WHERE token IS NOT NULL;
CREATE INDEX lead_sources_meta_page_idx ON lead_sources ((config->>'page_id')) WHERE kind = 'meta';
CREATE INDEX lead_sources_org_idx ON lead_sources (org_id, created_at DESC);

-- ── what each import or sync brought in ────────────────────────────────────
CREATE TABLE lead_imports (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  source_id   text,
  kind        text NOT NULL CHECK (kind IN ('csv', 'google_sheet', 'meta', 'webhook')),
  name        text,
  total       integer NOT NULL DEFAULT 0,
  created     integer NOT NULL DEFAULT 0,
  duplicates  integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  errors      jsonb NOT NULL DEFAULT '[]',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_imports_org_idx ON lead_imports (org_id, created_at DESC);
