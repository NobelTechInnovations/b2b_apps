-- ════════════════════════════════════════════════════════════════════════════
-- PAYROLL
--
-- Owns what a person is paid. It does NOT own who they are or when they
-- worked — those belong to HR, and are read over HTTP at the moment a run is
-- processed and then SNAPSHOTTED onto the payslip. A payslip must still read
-- correctly in three years when the employee has left, the shift has been
-- retimed and the salary has been revised twice.
--
-- Money is numeric(14,2). Computation happens in integer paise in JS and is
-- written back once, so no total is ever the sum of floats.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE payroll_settings (
  org_id            text PRIMARY KEY,

  -- Provident Fund
  pf_enabled        boolean NOT NULL DEFAULT true,
  pf_employee_rate  numeric(5,2) NOT NULL DEFAULT 12.00,
  pf_employer_rate  numeric(5,2) NOT NULL DEFAULT 12.00,
  -- Statutory PF wage ceiling. Employers may contribute on actual wages
  -- instead; that is a policy choice, hence the flag rather than a constant.
  pf_wage_ceiling   numeric(14,2) NOT NULL DEFAULT 15000.00,
  pf_on_actual_wage boolean NOT NULL DEFAULT false,

  -- Employees' State Insurance
  esi_enabled       boolean NOT NULL DEFAULT true,
  esi_employee_rate numeric(5,2) NOT NULL DEFAULT 0.75,
  esi_employer_rate numeric(5,2) NOT NULL DEFAULT 3.25,
  esi_gross_ceiling numeric(14,2) NOT NULL DEFAULT 21000.00,

  -- Professional tax is a state levy; the slab table lives in code keyed by
  -- this, because it changes per state budget rather than per workspace.
  pt_enabled        boolean NOT NULL DEFAULT true,
  pt_state          text NOT NULL DEFAULT 'MH',

  tds_enabled       boolean NOT NULL DEFAULT true,
  tds_regime        text NOT NULL DEFAULT 'new' CHECK (tds_regime IN ('new','old')),

  -- Overtime at 2× the ordinary hourly rate is the Factories Act default.
  overtime_multiplier numeric(4,2) NOT NULL DEFAULT 2.00,
  overtime_enabled    boolean NOT NULL DEFAULT true,
  -- Most Indian payroll divides a month by 26 paid days, not by its length.
  days_basis        text NOT NULL DEFAULT 'calendar'
                      CHECK (days_basis IN ('calendar','fixed_26','working')),

  payslip_prefix    text NOT NULL DEFAULT 'PS',
  currency          text NOT NULL DEFAULT 'INR',
  pay_day           integer NOT NULL DEFAULT 1 CHECK (pay_day BETWEEN 1 AND 28),
  employer_name     text,
  employer_address  text,
  employer_pan      text,
  employer_tan      text,
  pf_establishment  text,
  esi_establishment text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── what a salary is made of ────────────────────────────────────────────────
CREATE TABLE salary_components (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  name          text NOT NULL,
  code          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('earning','deduction','employer')),
  -- 'balance' absorbs whatever is left of gross after the others are computed,
  -- which is what "special allowance" is for.
  calculation   text NOT NULL DEFAULT 'fixed'
                  CHECK (calculation IN ('fixed','percent_of_basic','percent_of_gross','percent_of_ctc','balance','statutory')),
  value         numeric(14,4) NOT NULL DEFAULT 0,
  statutory_key text CHECK (statutory_key IN ('pf','esi','pt','tds','pf_employer','esi_employer','overtime','lop')),
  -- Whether this counts toward gross, toward PF wages, toward taxable income.
  part_of_gross boolean NOT NULL DEFAULT true,
  pf_applicable boolean NOT NULL DEFAULT false,
  esi_applicable boolean NOT NULL DEFAULT true,
  taxable       boolean NOT NULL DEFAULT true,
  -- Statutory and derived rows are not free-form; the editor locks them.
  is_system     boolean NOT NULL DEFAULT false,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

CREATE UNIQUE INDEX salary_components_org_code_key ON salary_components (org_id, upper(code)) WHERE archived_at IS NULL;
CREATE INDEX salary_components_org_idx ON salary_components (org_id, position) WHERE archived_at IS NULL;

CREATE TABLE salary_structures (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  name         text NOT NULL,
  code         text,
  description  text,
  is_default   boolean NOT NULL DEFAULT false,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);

CREATE UNIQUE INDEX salary_structures_org_name_key ON salary_structures (org_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX salary_structures_org_default_key ON salary_structures (org_id) WHERE is_default AND archived_at IS NULL;

CREATE TABLE structure_components (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  structure_id  text NOT NULL REFERENCES salary_structures (id) ON DELETE CASCADE,
  component_id  text NOT NULL REFERENCES salary_components (id) ON DELETE RESTRICT,
  -- A structure may override how a component is worked out without forking it.
  calculation   text CHECK (calculation IN ('fixed','percent_of_basic','percent_of_gross','percent_of_ctc','balance','statutory')),
  value         numeric(14,4),
  position      integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX structure_components_key ON structure_components (structure_id, component_id);
CREATE INDEX structure_components_org_idx ON structure_components (org_id, structure_id, position);

-- ── what one person is paid, and what they used to be paid ──────────────────
CREATE TABLE employee_salaries (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  -- No foreign key: employees live in the HR service's database. The id is
  -- carried and the name is snapshotted, which is the whole point of the
  -- service boundary.
  employee_id    text NOT NULL,
  structure_id   text REFERENCES salary_structures (id) ON DELETE SET NULL,
  annual_ctc     numeric(14,2) NOT NULL DEFAULT 0 CHECK (annual_ctc >= 0),
  monthly_gross  numeric(14,2) NOT NULL DEFAULT 0 CHECK (monthly_gross >= 0),
  effective_from date NOT NULL DEFAULT current_date,
  effective_to   date,
  revision_note  text,
  pan            text,
  uan            text,
  esi_number     text,
  bank_account   text,
  bank_ifsc      text,
  bank_name      text,
  payment_mode   text NOT NULL DEFAULT 'bank' CHECK (payment_mode IN ('bank','cash','cheque','upi')),
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employee_salaries_lookup ON employee_salaries (org_id, employee_id, effective_from DESC);
-- One salary can be in force at a time; a revision closes the previous row.
CREATE UNIQUE INDEX employee_salaries_open_key ON employee_salaries (org_id, employee_id)
  WHERE effective_to IS NULL;

-- ── a month's payroll ───────────────────────────────────────────────────────
CREATE TABLE payroll_runs (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  period_year    integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  period_month   integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  label          text NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','review','approved','paid','cancelled')),
  headcount      integer NOT NULL DEFAULT 0,
  gross_total    numeric(14,2) NOT NULL DEFAULT 0,
  deduction_total numeric(14,2) NOT NULL DEFAULT 0,
  net_total      numeric(14,2) NOT NULL DEFAULT 0,
  employer_cost  numeric(14,2) NOT NULL DEFAULT 0,
  -- Why a number is what it is: which days were counted, which were lost.
  attendance_from date,
  attendance_to   date,
  notes          text,
  processed_by   text,
  processed_at   timestamptz,
  approved_by    text,
  approved_at    timestamptz,
  paid_at        timestamptz,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One live run per month. A cancelled run keeps its period free for a redo.
CREATE UNIQUE INDEX payroll_runs_period_key ON payroll_runs (org_id, period_year, period_month)
  WHERE status <> 'cancelled';
CREATE INDEX payroll_runs_org_idx ON payroll_runs (org_id, period_year DESC, period_month DESC);

CREATE TABLE payslips (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  run_id          text NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
  employee_id     text NOT NULL,
  payslip_number  text NOT NULL,

  -- Snapshot. These are deliberately copies, not joins.
  employee_name   text NOT NULL,
  employee_code   text,
  designation     text,
  department_name text,
  joined_on       date,
  pan             text,
  uan             text,
  esi_number      text,
  bank_account    text,
  bank_name       text,

  days_in_period  numeric(6,2) NOT NULL DEFAULT 0,
  payable_days    numeric(6,2) NOT NULL DEFAULT 0,
  lop_days        numeric(6,2) NOT NULL DEFAULT 0,
  leave_days      numeric(6,2) NOT NULL DEFAULT 0,
  overtime_hours  numeric(8,2) NOT NULL DEFAULT 0,

  monthly_gross   numeric(14,2) NOT NULL DEFAULT 0,
  gross_earnings  numeric(14,2) NOT NULL DEFAULT 0,
  total_deductions numeric(14,2) NOT NULL DEFAULT 0,
  net_pay         numeric(14,2) NOT NULL DEFAULT 0,
  employer_contrib numeric(14,2) NOT NULL DEFAULT 0,
  ctc_for_period  numeric(14,2) NOT NULL DEFAULT 0,

  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','paid','held')),
  hold_reason     text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payslips_run_employee_key ON payslips (run_id, employee_id);
CREATE UNIQUE INDEX payslips_number_key ON payslips (org_id, payslip_number);
CREATE INDEX payslips_employee_idx ON payslips (org_id, employee_id, created_at DESC);

CREATE TABLE payslip_lines (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  payslip_id   text NOT NULL REFERENCES payslips (id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('earning','deduction','employer')),
  amount       numeric(14,2) NOT NULL DEFAULT 0,
  -- Plain-English working, e.g. "12% of ₹15,000 (PF wage ceiling)". A payslip
  -- nobody can check by hand is a payslip nobody trusts.
  basis        text,
  position     integer NOT NULL DEFAULT 0
);

CREATE INDEX payslip_lines_payslip_idx ON payslip_lines (payslip_id, position);
CREATE INDEX payslip_lines_org_code_idx ON payslip_lines (org_id, code);

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

CREATE TRIGGER payroll_settings_touch   BEFORE UPDATE ON payroll_settings   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER salary_structures_touch  BEFORE UPDATE ON salary_structures  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER employee_salaries_touch  BEFORE UPDATE ON employee_salaries  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER payroll_runs_touch       BEFORE UPDATE ON payroll_runs       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER payslips_touch           BEFORE UPDATE ON payslips           FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
