-- ════════════════════════════════════════════════════════════════════════════
-- Manual attendance needs approval.
--
-- A punch terminal is evidence; a person typing a time is a claim. So the
-- attendance table — the one payroll reads — only ever holds evidence or
-- approved claims. Everything typed by somebody without approval rights waits
-- here until an approver accepts or rejects it.
--
-- That separation is the point: payroll cannot pay on an unapproved entry,
-- because an unapproved entry is not in the table payroll reads.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE attendance_requests (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  employee_id   text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  on_date       date NOT NULL,

  -- What is being claimed. A status on its own ("I was on-site all day") is a
  -- valid claim; so is a pair of times ("I forgot to punch out at 18:40").
  status        text NOT NULL DEFAULT 'present'
                  CHECK (status IN ('present','absent','half_day','remote','holiday','weekend')),
  check_in_at   timestamptz,
  check_out_at  timestamptz,
  reason        text,

  -- Where the claim came from: HR staff marking a day, the check-in buttons,
  -- or the employee regularising their own attendance from the portal.
  via           text NOT NULL DEFAULT 'hr' CHECK (via IN ('hr','check_in','portal')),
  requested_by  text NOT NULL,

  -- What the record said when the claim was made, so an approver can see
  -- exactly what they are overriding.
  previous      jsonb,

  decision      text NOT NULL DEFAULT 'pending'
                  CHECK (decision IN ('pending','approved','rejected','withdrawn')),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  attendance_id text REFERENCES attendance (id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_requests_times_ordered
    CHECK (check_in_at IS NULL OR check_out_at IS NULL OR check_out_at > check_in_at)
);

-- One open claim per person per day. A second check-out on the same day
-- updates the open claim rather than stacking a queue of contradictions.
CREATE UNIQUE INDEX attendance_requests_open_key
  ON attendance_requests (org_id, employee_id, on_date) WHERE decision = 'pending';
CREATE INDEX attendance_requests_queue_idx
  ON attendance_requests (org_id, created_at) WHERE decision = 'pending';
CREATE INDEX attendance_requests_employee_idx
  ON attendance_requests (org_id, employee_id, on_date DESC);

-- Who accepted a manual day, so an audit can tell evidence from judgement.
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

CREATE TRIGGER attendance_requests_touch BEFORE UPDATE ON attendance_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
