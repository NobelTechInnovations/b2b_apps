-- ════════════════════════════════════════════════════════════════════════════
-- The employee's own view of their employment.
--
-- Three things that only make sense together: a link from an employee record
-- to a platform login, a performance record worth showing them, and the
-- documents their employment produced.
-- ════════════════════════════════════════════════════════════════════════════

-- ── portal access ───────────────────────────────────────────────────────────
-- `user_id` already exists on employees. It gains meaning here: it is the only
-- way a self-service request resolves to a person. Unique, because two
-- employee records sharing a login would make "my payslips" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS employees_org_user_key
  ON employees (org_id, user_id) WHERE user_id IS NOT NULL AND archived_at IS NULL;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS portal_status text NOT NULL DEFAULT 'none'
    CHECK (portal_status IN ('none','invited','active','suspended')),
  ADD COLUMN IF NOT EXISTS portal_invited_at timestamptz,
  ADD COLUMN IF NOT EXISTS portal_linked_at  timestamptz;

-- ── performance ─────────────────────────────────────────────────────────────
CREATE TABLE review_cycles (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  name           text NOT NULL,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  -- A cycle moves forward only. Reopening a shared cycle would let a rating
  -- change after the person has already read it.
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','self_review','manager_review','calibration','shared','closed')),
  self_review_due    date,
  manager_review_due date,
  -- What people are rated on. Free-form per workspace, because a factory and
  -- an agency do not assess the same things.
  competencies   jsonb NOT NULL DEFAULT '[]',
  rating_scale   integer NOT NULL DEFAULT 5 CHECK (rating_scale BETWEEN 3 AND 10),
  instructions   text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);

CREATE UNIQUE INDEX review_cycles_org_name_key ON review_cycles (org_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX review_cycles_org_status_idx ON review_cycles (org_id, status) WHERE archived_at IS NULL;

CREATE TABLE reviews (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  cycle_id      text NOT NULL REFERENCES review_cycles (id) ON DELETE CASCADE,
  employee_id   text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  -- Snapshotted, because a reviewer may leave before the cycle is read back.
  reviewer_id   text REFERENCES employees (id) ON DELETE SET NULL,
  reviewer_name text,

  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','self_submitted','manager_submitted','shared','acknowledged')),

  -- Scores per competency, keyed by competency name.
  self_scores     jsonb NOT NULL DEFAULT '{}',
  manager_scores  jsonb NOT NULL DEFAULT '{}',
  self_comments   text,
  manager_comments text,
  strengths       text,
  improvements    text,
  -- The one number that goes on the record, set at calibration.
  overall_rating  numeric(4,2) CHECK (overall_rating IS NULL OR overall_rating >= 0),
  recommendation  text CHECK (recommendation IS NULL OR recommendation IN
                    ('exceeds','meets','below','promote','improve','exit')),

  self_submitted_at    timestamptz,
  manager_submitted_at timestamptz,
  shared_at            timestamptz,
  acknowledged_at      timestamptz,
  acknowledgement      text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX reviews_cycle_employee_key ON reviews (cycle_id, employee_id);
CREATE INDEX reviews_org_employee_idx ON reviews (org_id, employee_id, created_at DESC);
CREATE INDEX reviews_org_reviewer_idx ON reviews (org_id, reviewer_id) WHERE status IN ('pending','self_submitted');

CREATE TABLE goals (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  employee_id  text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  cycle_id     text REFERENCES review_cycles (id) ON DELETE SET NULL,
  title        text NOT NULL,
  description  text,
  -- What "done" means, in the employee's own units.
  metric       text,
  target_value numeric(14,2),
  current_value numeric(14,2) NOT NULL DEFAULT 0,
  unit         text,
  -- Weight lets three goals of unequal importance roll into one number.
  weight       integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10),
  progress     integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('draft','active','achieved','missed','dropped')),
  due_on       date,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX goals_org_employee_idx ON goals (org_id, employee_id, status);
CREATE INDEX goals_org_cycle_idx ON goals (org_id, cycle_id) WHERE cycle_id IS NOT NULL;

-- ── employment documents ────────────────────────────────────────────────────
/*
 * Letters the employment itself produces — offers, confirmations, increments,
 * relieving letters. They are GENERATED here rather than uploaded, so the
 * figures in them come from the record instead of being retyped, and an issued
 * letter is frozen: the rendered body is stored, not re-rendered on read.
 */
CREATE TABLE letter_templates (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'offer'
                 CHECK (kind IN ('offer','appointment','confirmation','increment','promotion',
                                 'experience','relieving','warning','noc','custom')),
  -- Markdown with {{placeholders}} filled from the employee and their salary.
  body         text NOT NULL,
  subject      text,
  is_default   boolean NOT NULL DEFAULT false,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);

CREATE UNIQUE INDEX letter_templates_org_name_key ON letter_templates (org_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX letter_templates_org_kind_default_key ON letter_templates (org_id, kind) WHERE is_default AND archived_at IS NULL;

CREATE TABLE employee_documents (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  employee_id  text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  template_id  text REFERENCES letter_templates (id) ON DELETE SET NULL,

  kind         text NOT NULL DEFAULT 'offer'
                 CHECK (kind IN ('offer','appointment','confirmation','increment','promotion',
                                 'experience','relieving','warning','noc','id_proof',
                                 'certificate','contract','custom')),
  title        text NOT NULL,
  reference    text,
  -- The rendered letter, frozen at issue. Null for an uploaded document.
  body         text,
  -- A file in the Documents app, for scans and signed copies. Just an id: HR
  -- never reaches into another service's storage.
  document_id  text,
  file_name    text,

  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','issued','acknowledged','revoked')),
  -- Whether the person can see it in their portal. An internal warning note
  -- and a signed offer letter are not the same thing.
  visible_to_employee boolean NOT NULL DEFAULT true,
  requires_acknowledgement boolean NOT NULL DEFAULT false,

  issued_on       date,
  valid_until     date,
  issued_by       text,
  acknowledged_at timestamptz,
  acknowledgement_ip text,
  revoked_at      timestamptz,
  revoke_reason   text,
  notes           text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX employee_documents_reference_key ON employee_documents (org_id, reference) WHERE reference IS NOT NULL;
CREATE INDEX employee_documents_employee_idx ON employee_documents (org_id, employee_id, created_at DESC);
CREATE INDEX employee_documents_pending_idx ON employee_documents (org_id, employee_id)
  WHERE status = 'issued' AND requires_acknowledgement AND acknowledged_at IS NULL;

CREATE TRIGGER review_cycles_touch      BEFORE UPDATE ON review_cycles      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER reviews_touch            BEFORE UPDATE ON reviews            FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER goals_touch              BEFORE UPDATE ON goals              FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER letter_templates_touch   BEFORE UPDATE ON letter_templates   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER employee_documents_touch BEFORE UPDATE ON employee_documents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
