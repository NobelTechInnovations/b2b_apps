-- ════════════════════════════════════════════════════════════════════════════
-- What a person currently earns, as HR sees it.
--
-- Payroll owns salary. HR needs the figure for exactly one thing — printing it
-- on an offer or appointment letter — and reading it synchronously would make
-- the dependency circular: payroll already reads HR's roster and attendance.
--
-- So payroll PUSHES. It emits `payroll.salary.revised`, HR keeps this slim
-- projection, and the cycle disappears. A projection is right here in a way it
-- is not for attendance: a salary changes on a revision, not continuously, so
-- there is no window where the copy is stale exactly when it matters.
--
-- This table is never written by a human and never read by payroll.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE employee_salary_snapshot (
  org_id         text NOT NULL,
  employee_id    text NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  annual_ctc     numeric(14,2) NOT NULL DEFAULT 0,
  monthly_gross  numeric(14,2) NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'INR',
  effective_from date,
  -- Lets a late-delivered event be ignored rather than overwrite a newer one.
  revised_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, employee_id)
);

CREATE INDEX employee_salary_snapshot_org_idx ON employee_salary_snapshot (org_id);
