-- ════════════════════════════════════════════════════════════════════════════
-- Working hours, biometric devices, and the overtime that falls out of them.
--
-- HR owns time. Payroll owns money. The seam is a per-period summary of days
-- worked, days lost and overtime minutes — computed here, read by payroll.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE shifts (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  name            text NOT NULL,
  code            text,
  starts_at       time NOT NULL DEFAULT '09:00',
  ends_at         time NOT NULL DEFAULT '18:00',
  break_minutes   integer NOT NULL DEFAULT 60 CHECK (break_minutes >= 0),
  -- ISO weekday numbers that are working days: 1 = Monday … 7 = Sunday.
  working_days    integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  -- Late arrival forgiven up to this many minutes.
  grace_minutes   integer NOT NULL DEFAULT 10 CHECK (grace_minutes >= 0),
  -- Below this, the day counts as a half day; below half of it, absent.
  half_day_minutes integer NOT NULL DEFAULT 240,
  -- A shift that ends before it starts runs past midnight.
  is_night_shift  boolean NOT NULL DEFAULT false,
  overtime_after_minutes integer NOT NULL DEFAULT 0,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

CREATE UNIQUE INDEX shifts_org_name_key ON shifts (org_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX shifts_org_default_key ON shifts (org_id) WHERE is_default AND archived_at IS NULL;

-- Shift assignment is dated, so a change of hours does not rewrite history.
CREATE TABLE employee_shifts (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  employee_id   text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  shift_id      text NOT NULL REFERENCES shifts (id) ON DELETE RESTRICT,
  effective_from date NOT NULL DEFAULT current_date,
  effective_to   date,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employee_shifts_lookup ON employee_shifts (org_id, employee_id, effective_from DESC);

-- ── biometric / access-control devices ──────────────────────────────────────
CREATE TABLE devices (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  name         text NOT NULL,
  location     text,
  serial       text,
  kind         text NOT NULL DEFAULT 'biometric'
                 CHECK (kind IN ('biometric','rfid','face','mobile','manual')),
  -- Only the hash is stored; the plaintext key is shown once at creation.
  api_key_hash text NOT NULL,
  api_key_hint text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_seen_at timestamptz,
  punch_count  integer NOT NULL DEFAULT 0,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX devices_api_key_key ON devices (api_key_hash);
CREATE INDEX devices_org_idx ON devices (org_id) WHERE status = 'active';

-- Raw punches are kept exactly as the device sent them. Attendance is derived
-- from them and can be rebuilt; a punch is never edited, only superseded.
CREATE TABLE punches (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  device_id     text REFERENCES devices (id) ON DELETE SET NULL,
  employee_id   text REFERENCES employees (id) ON DELETE CASCADE,
  -- What the device reported, before we resolved it to an employee.
  employee_ref  text NOT NULL,
  punched_at    timestamptz NOT NULL,
  direction     text CHECK (direction IN ('in','out')),
  -- Unmatched punches are retained so a mis-enrolled card can be fixed later.
  status        text NOT NULL DEFAULT 'matched'
                  CHECK (status IN ('matched','unmatched','duplicate','ignored')),
  raw           jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX punches_org_employee_idx ON punches (org_id, employee_id, punched_at);
CREATE INDEX punches_org_status_idx   ON punches (org_id, status) WHERE status = 'unmatched';
-- The same punch replayed by a device must not create a second row.
CREATE UNIQUE INDEX punches_dedupe_key ON punches (org_id, employee_ref, punched_at);

-- Devices identify people by whatever they were enrolled with — a card
-- number, a finger id, an employee code. Map it here rather than forcing
-- the HR record to carry device-specific identifiers.
CREATE TABLE device_identities (
  org_id      text NOT NULL,
  employee_ref text NOT NULL,
  employee_id text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, employee_ref)
);

CREATE INDEX device_identities_employee_idx ON device_identities (org_id, employee_id);

-- ── attendance gains time accounting ────────────────────────────────────────
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS shift_id          text REFERENCES shifts (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expected_minutes  integer,
  ADD COLUMN IF NOT EXISTS overtime_minutes  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shortfall_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_minutes      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS early_exit_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source            text NOT NULL DEFAULT 'manual'
                                               CHECK (source IN ('manual','device','import','self'));

CREATE INDEX IF NOT EXISTS attendance_org_overtime_idx ON attendance (org_id, on_date)
  WHERE overtime_minutes > 0;

CREATE TRIGGER shifts_touch BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
