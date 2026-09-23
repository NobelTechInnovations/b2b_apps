-- ════════════════════════════════════════════════════════════════════════════
-- HR — the system of record for your people.
--
-- An employee is NOT a platform user. Most of the workforce never logs in, and
-- the ones who do may join or leave the workspace independently of their
-- employment. `user_id` is an optional link, never a foreign key into identity.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE departments (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  code        text,
  parent_id   text REFERENCES departments (id) ON DELETE SET NULL,
  head_employee_id text,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE UNIQUE INDEX departments_org_name_key ON departments (org_id, lower(name))
  WHERE archived_at IS NULL;
CREATE INDEX departments_org_idx ON departments (org_id) WHERE archived_at IS NULL;

-- ── employees ───────────────────────────────────────────────────────────────
CREATE TABLE employees (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  employee_code   text NOT NULL,
  -- Optional link to a platform login. Null for everyone who never signs in.
  user_id         text,
  first_name      text NOT NULL,
  last_name       text,
  email           text,
  personal_email  text,
  phone           text,
  date_of_birth   date,
  gender          text CHECK (gender IN ('female','male','other','undisclosed')),
  department_id   text REFERENCES departments (id) ON DELETE SET NULL,
  designation     text,
  manager_id      text REFERENCES employees (id) ON DELETE SET NULL,
  employment_type text NOT NULL DEFAULT 'full_time'
                    CHECK (employment_type IN ('full_time','part_time','contract','intern','consultant')),
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','on_probation','on_notice','exited','on_leave')),
  work_location   text,
  joined_on       date NOT NULL DEFAULT current_date,
  probation_ends_on date,
  exited_on       date,
  exit_reason     text,
  address         jsonb NOT NULL DEFAULT '{}',
  emergency_contact jsonb NOT NULL DEFAULT '{}',
  tags            text[] NOT NULL DEFAULT '{}',
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

CREATE UNIQUE INDEX employees_org_code_key ON employees (org_id, lower(employee_code))
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX employees_org_email_key ON employees (org_id, lower(email))
  WHERE email IS NOT NULL AND archived_at IS NULL;
CREATE INDEX employees_org_idx        ON employees (org_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX employees_org_status_idx ON employees (org_id, status)          WHERE archived_at IS NULL;
CREATE INDEX employees_org_dept_idx   ON employees (org_id, department_id)   WHERE archived_at IS NULL;
CREATE INDEX employees_org_manager    ON employees (org_id, manager_id)      WHERE archived_at IS NULL;
CREATE INDEX employees_org_user_idx   ON employees (org_id, user_id)         WHERE user_id IS NOT NULL;
-- Birthdays and work anniversaries, without scanning the table.
CREATE INDEX employees_org_dob_idx    ON employees (org_id, (extract(month from date_of_birth)), (extract(day from date_of_birth)));

-- ── attendance ──────────────────────────────────────────────────────────────
-- One row per person per day. The unique index is what makes double
-- check-ins impossible rather than merely unlikely.
CREATE TABLE attendance (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  employee_id   text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  on_date       date NOT NULL,
  check_in_at   timestamptz,
  check_out_at  timestamptz,
  status        text NOT NULL DEFAULT 'present'
                  CHECK (status IN ('present','absent','half_day','on_leave','holiday','weekend','remote')),
  work_minutes  integer,
  notes         text,
  recorded_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX attendance_org_employee_date_key ON attendance (org_id, employee_id, on_date);
CREATE INDEX attendance_org_date_idx ON attendance (org_id, on_date DESC);

-- ── leave ───────────────────────────────────────────────────────────────────
CREATE TABLE leave_types (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  name           text NOT NULL,
  code           text NOT NULL,
  days_per_year  numeric(5,1) NOT NULL DEFAULT 0,
  is_paid        boolean NOT NULL DEFAULT true,
  carry_forward  boolean NOT NULL DEFAULT false,
  requires_approval boolean NOT NULL DEFAULT true,
  colour         text NOT NULL DEFAULT 'slate',
  position       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);

CREATE UNIQUE INDEX leave_types_org_code_key ON leave_types (org_id, lower(code))
  WHERE archived_at IS NULL;

CREATE TABLE leave_balances (
  org_id        text NOT NULL,
  employee_id   text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  leave_type_id text NOT NULL REFERENCES leave_types (id) ON DELETE CASCADE,
  year          integer NOT NULL,
  entitled      numeric(5,1) NOT NULL DEFAULT 0,
  carried       numeric(5,1) NOT NULL DEFAULT 0,
  used          numeric(5,1) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, leave_type_id, year)
);

CREATE INDEX leave_balances_org_idx ON leave_balances (org_id, year);

CREATE TABLE leave_requests (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  employee_id   text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  leave_type_id text NOT NULL REFERENCES leave_types (id) ON DELETE RESTRICT,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  days          numeric(5,1) NOT NULL,
  half_day      boolean NOT NULL DEFAULT false,
  reason        text,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','cancelled')),
  approver_id   text,
  decided_at    timestamptz,
  decision_note text,
  requested_by  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_dates_ordered CHECK (end_date >= start_date)
);

CREATE INDEX leave_requests_org_idx       ON leave_requests (org_id, created_at DESC);
CREATE INDEX leave_requests_org_status    ON leave_requests (org_id, status);
CREATE INDEX leave_requests_org_employee  ON leave_requests (org_id, employee_id, start_date DESC);
-- Overlap detection for a given person, without a sequential scan.
CREATE INDEX leave_requests_org_range     ON leave_requests (org_id, employee_id, start_date, end_date)
  WHERE status IN ('pending','approved');

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

CREATE TRIGGER employees_touch      BEFORE UPDATE ON employees      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER departments_touch    BEFORE UPDATE ON departments    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER attendance_touch     BEFORE UPDATE ON attendance     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER leave_requests_touch BEFORE UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
