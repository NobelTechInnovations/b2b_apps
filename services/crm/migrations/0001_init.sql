-- ════════════════════════════════════════════════════════════════════════════
-- CRM — the system of record for who your customers are.
--
-- Every table carries org_id as the first column of its primary index. A query
-- without it cannot use an index, which makes accidental cross-tenant reads
-- both wrong AND slow — the kind of mistake that shows up immediately.
-- ════════════════════════════════════════════════════════════════════════════

-- ── companies ───────────────────────────────────────────────────────────────
CREATE TABLE companies (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  name          text NOT NULL,
  legal_name    text,
  domain        text,
  industry      text,
  size_band     text,
  phone         text,
  email         text,
  website       text,
  tax_id        text,
  address       jsonb NOT NULL DEFAULT '{}',
  -- A company becomes a customer the moment a deal is won against it.
  is_customer   boolean NOT NULL DEFAULT false,
  customer_since timestamptz,
  owner_user_id text,
  tags          text[] NOT NULL DEFAULT '{}',
  notes         text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

CREATE INDEX companies_org_idx        ON companies (org_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX companies_org_name_idx   ON companies (org_id, lower(name))     WHERE archived_at IS NULL;
CREATE INDEX companies_org_owner_idx  ON companies (org_id, owner_user_id)   WHERE archived_at IS NULL;
CREATE UNIQUE INDEX companies_org_domain_key ON companies (org_id, lower(domain))
  WHERE domain IS NOT NULL AND archived_at IS NULL;

-- ── contacts ────────────────────────────────────────────────────────────────
CREATE TABLE contacts (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  company_id    text REFERENCES companies (id) ON DELETE SET NULL,
  first_name    text NOT NULL,
  last_name     text,
  email         text,
  phone         text,
  mobile        text,
  job_title     text,
  department    text,
  linkedin      text,
  is_primary    boolean NOT NULL DEFAULT false,
  owner_user_id text,
  tags          text[] NOT NULL DEFAULT '{}',
  notes         text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

CREATE INDEX contacts_org_idx       ON contacts (org_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX contacts_org_company   ON contacts (org_id, company_id)      WHERE archived_at IS NULL;
CREATE INDEX contacts_org_email_idx ON contacts (org_id, lower(email))    WHERE archived_at IS NULL;
CREATE INDEX contacts_org_name_idx  ON contacts (org_id, lower(first_name), lower(last_name));

-- ── leads ───────────────────────────────────────────────────────────────────
-- A lead is an unqualified enquiry. It is deliberately flat: no company or
-- contact record exists until it converts, so unqualified noise never pollutes
-- the customer database.
CREATE TABLE leads (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  first_name     text NOT NULL,
  last_name      text,
  company_name   text,
  email          text,
  phone          text,
  job_title      text,
  source         text NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','website','referral','campaign','event','cold_call','import','api','partner')),
  status         text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','contacted','qualified','unqualified','converted')),
  rating         text CHECK (rating IN ('hot','warm','cold')),
  score          integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  estimated_value numeric(14,2),
  currency       text NOT NULL DEFAULT 'INR',
  owner_user_id  text,
  tags           text[] NOT NULL DEFAULT '{}',
  notes          text,
  -- Set on conversion so the trail from enquiry to customer is never lost.
  converted_at        timestamptz,
  converted_contact_id text,
  converted_company_id text,
  converted_deal_id    text,
  unqualified_reason  text,
  last_contacted_at timestamptz,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);

CREATE INDEX leads_org_idx        ON leads (org_id, created_at DESC)  WHERE archived_at IS NULL;
CREATE INDEX leads_org_status_idx ON leads (org_id, status)           WHERE archived_at IS NULL;
CREATE INDEX leads_org_owner_idx  ON leads (org_id, owner_user_id)    WHERE archived_at IS NULL;
CREATE INDEX leads_org_email_idx  ON leads (org_id, lower(email))     WHERE archived_at IS NULL;

-- ── pipelines & stages ──────────────────────────────────────────────────────
CREATE TABLE pipelines (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pipelines_org_idx ON pipelines (org_id, position);
CREATE UNIQUE INDEX pipelines_org_default_key ON pipelines (org_id) WHERE is_default;

CREATE TABLE stages (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  pipeline_id  text NOT NULL REFERENCES pipelines (id) ON DELETE CASCADE,
  name         text NOT NULL,
  position     integer NOT NULL DEFAULT 0,
  -- Used for weighted forecasting.
  probability  integer NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
  kind         text NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
  colour       text NOT NULL DEFAULT 'slate',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stages_org_pipeline_idx ON stages (org_id, pipeline_id, position);

-- ── deals ───────────────────────────────────────────────────────────────────
CREATE TABLE deals (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  pipeline_id   text NOT NULL REFERENCES pipelines (id) ON DELETE RESTRICT,
  stage_id      text NOT NULL REFERENCES stages (id) ON DELETE RESTRICT,
  company_id    text REFERENCES companies (id) ON DELETE SET NULL,
  contact_id    text REFERENCES contacts (id) ON DELETE SET NULL,
  title         text NOT NULL,
  value         numeric(14,2) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'INR',
  probability   integer NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  expected_close_date date,
  closed_at     timestamptz,
  lost_reason   text,
  source        text,
  owner_user_id text,
  tags          text[] NOT NULL DEFAULT '{}',
  description   text,
  -- Ordering within a kanban column. Fractional so a drop between two cards
  -- never has to renumber the whole column.
  board_position double precision NOT NULL DEFAULT 1000,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

CREATE INDEX deals_org_idx         ON deals (org_id, created_at DESC)              WHERE archived_at IS NULL;
CREATE INDEX deals_org_stage_idx   ON deals (org_id, stage_id, board_position)     WHERE archived_at IS NULL;
CREATE INDEX deals_org_status_idx  ON deals (org_id, status)                       WHERE archived_at IS NULL;
CREATE INDEX deals_org_company_idx ON deals (org_id, company_id)                   WHERE archived_at IS NULL;
CREATE INDEX deals_org_owner_idx   ON deals (org_id, owner_user_id)                WHERE archived_at IS NULL;
CREATE INDEX deals_org_close_idx   ON deals (org_id, expected_close_date)          WHERE status = 'open' AND archived_at IS NULL;

-- Every stage change, kept for cycle-time and conversion reporting.
CREATE TABLE deal_stage_history (
  id            bigserial PRIMARY KEY,
  org_id        text NOT NULL,
  deal_id       text NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  from_stage_id text,
  to_stage_id   text NOT NULL,
  moved_by      text,
  moved_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deal_stage_history_deal_idx ON deal_stage_history (org_id, deal_id, moved_at DESC);

-- ── activities ──────────────────────────────────────────────────────────────
-- One timeline for calls, meetings, emails, tasks and notes, attached to any
-- CRM record. Polymorphic by (related_type, related_id).
CREATE TABLE activities (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('call','meeting','email','task','note')),
  subject       text NOT NULL,
  body          text,
  related_type  text CHECK (related_type IN ('lead','contact','company','deal')),
  related_id    text,
  due_at        timestamptz,
  completed_at  timestamptz,
  outcome       text,
  duration_minutes integer,
  assigned_to   text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activities_org_related_idx ON activities (org_id, related_type, related_id, created_at DESC);
CREATE INDEX activities_org_due_idx     ON activities (org_id, due_at) WHERE completed_at IS NULL;
CREATE INDEX activities_org_assigned    ON activities (org_id, assigned_to, due_at) WHERE completed_at IS NULL;

-- ── outbox ──────────────────────────────────────────────────────────────────
CREATE TABLE outbox (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  org_id       text,
  actor_id     text,
  data         jsonb NOT NULL DEFAULT '{}',
  version      integer NOT NULL DEFAULT 1,
  attempts     integer NOT NULL DEFAULT 0,
  claimed_at   timestamptz,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_touch  BEFORE UPDATE ON companies  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER contacts_touch   BEFORE UPDATE ON contacts   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER leads_touch      BEFORE UPDATE ON leads      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER deals_touch      BEFORE UPDATE ON deals      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER activities_touch BEFORE UPDATE ON activities FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
