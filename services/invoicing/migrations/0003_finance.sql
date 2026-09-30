-- ════════════════════════════════════════════════════════════════════════════
-- FINANCE — Accounting, Asset Management and Recurring Billing, next to the
-- invoices they post from.
--
-- The general ledger is double-entry: every journal entry's debits equal its
-- credits, to the paisa, or it is not written. Other apps never write here;
-- they publish events (an invoice issued, a till sale, goods received) and
-- the posting rules in this service turn them into entries — each exactly
-- once, keyed by where it came from.
-- ════════════════════════════════════════════════════════════════════════════

-- Invoices can now come from quotes, field visits and subscriptions too.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_source_check
  CHECK (source IN ('manual', 'deal_won', 'recurring', 'import', 'api', 'quote', 'field_service'));

-- ── chart of accounts ───────────────────────────────────────────────────────
CREATE TABLE accounts (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  -- The account an automatic posting looks for ("the receivables account").
  system_key  text,
  description text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_code_key ON accounts (org_id, code);
CREATE UNIQUE INDEX accounts_system_key ON accounts (org_id, system_key) WHERE system_key IS NOT NULL;

CREATE TABLE journal_entries (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  number         text NOT NULL,
  entry_date     date NOT NULL,
  memo           text NOT NULL DEFAULT '',
  source         text NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual', 'invoice', 'payment', 'pos', 'pos_refund', 'store', 'purchase', 'expense',
                                     'payroll', 'depreciation', 'asset', 'bank', 'reversal', 'opening')),
  source_ref     text,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  reversed_by_id text REFERENCES journal_entries (id) ON DELETE SET NULL,
  reverses_id    text REFERENCES journal_entries (id) ON DELETE SET NULL,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX journal_entries_number_key ON journal_entries (org_id, number);
-- One entry per source document: a redelivered event cannot post twice.
CREATE UNIQUE INDEX journal_entries_source_key ON journal_entries (org_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX journal_entries_date_idx ON journal_entries (org_id, entry_date DESC);

CREATE TABLE journal_lines (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  entry_id     text NOT NULL REFERENCES journal_entries (id) ON DELETE CASCADE,
  position     integer NOT NULL DEFAULT 0,
  account_id   text NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  debit        numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description  text NOT NULL DEFAULT '',
  CHECK (debit = 0 OR credit = 0),
  CHECK (debit > 0 OR credit > 0)
);
CREATE INDEX journal_lines_account_idx ON journal_lines (org_id, account_id);
CREATE INDEX journal_lines_entry_idx ON journal_lines (org_id, entry_id);

-- ── bank ────────────────────────────────────────────────────────────────────
CREATE TABLE bank_accounts (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  name            text NOT NULL,
  account_id      text NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  bank_name       text,
  account_last4   text,
  ifsc            text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bank_accounts_ledger_key ON bank_accounts (org_id, account_id);

CREATE TABLE bank_transactions (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  bank_account_id text NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
  txn_date        date NOT NULL,
  description     text NOT NULL DEFAULT '',
  reference       text,
  -- Money in is positive, money out negative, as on a statement.
  amount          numeric(14,2) NOT NULL CHECK (amount <> 0),
  matched_line_id text REFERENCES journal_lines (id) ON DELETE SET NULL,
  matched_by      text,
  matched_at      timestamptz,
  import_hash     text NOT NULL,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- The same statement imported twice adds nothing.
CREATE UNIQUE INDEX bank_transactions_import_key ON bank_transactions (org_id, bank_account_id, import_hash);
CREATE UNIQUE INDEX bank_transactions_line_key ON bank_transactions (org_id, matched_line_id) WHERE matched_line_id IS NOT NULL;

-- ── fixed assets ────────────────────────────────────────────────────────────
CREATE TABLE fixed_assets (
  id                       text PRIMARY KEY,
  org_id                   text NOT NULL,
  number                   text NOT NULL,
  name                     text NOT NULL,
  category                 text,
  purchase_date            date NOT NULL,
  cost                     numeric(14,2) NOT NULL CHECK (cost > 0),
  salvage_value            numeric(14,2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  -- Straight line spreads (cost − salvage) over the life; written-down
  -- value takes a fixed percentage of what is left each year.
  method                   text NOT NULL DEFAULT 'slm' CHECK (method IN ('slm', 'wdv')),
  useful_life_months       integer CHECK (useful_life_months IS NULL OR useful_life_months BETWEEN 1 AND 1200),
  wdv_rate                 numeric(5,2) CHECK (wdv_rate IS NULL OR (wdv_rate > 0 AND wdv_rate <= 100)),
  accumulated_depreciation numeric(14,2) NOT NULL DEFAULT 0,
  last_depreciated_period  date,
  location                 text,
  custodian                text,
  serial_number            text,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  disposed_on              date,
  disposal_amount          numeric(14,2),
  notes                    text NOT NULL DEFAULT '',
  created_by               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (salvage_value < cost),
  CHECK ((method = 'slm' AND useful_life_months IS NOT NULL) OR (method = 'wdv' AND wdv_rate IS NOT NULL))
);
CREATE UNIQUE INDEX fixed_assets_number_key ON fixed_assets (org_id, number);

CREATE TABLE asset_depreciation (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  asset_id         text NOT NULL REFERENCES fixed_assets (id) ON DELETE CASCADE,
  period           date NOT NULL,              -- first day of the month
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  journal_entry_id text REFERENCES journal_entries (id) ON DELETE SET NULL,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period)
);
CREATE INDEX asset_depreciation_period_idx ON asset_depreciation (org_id, period);

-- ── recurring billing ───────────────────────────────────────────────────────
CREATE TABLE recurring_plans (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  interval    text NOT NULL DEFAULT 'monthly' CHECK (interval IN ('monthly', 'quarterly', 'half_yearly', 'yearly')),
  trial_days  integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  tax_rate    numeric(5,2) NOT NULL DEFAULT 18,
  hsn_sac     text,
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recurring_plans_name_key ON recurring_plans (org_id, lower(name));

CREATE TABLE subscriptions (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL,
  number               text NOT NULL,
  customer_id          text REFERENCES customers (id) ON DELETE SET NULL,
  customer_name        text NOT NULL,
  customer_email       text,
  customer_gstin       text,
  plan_id              text NOT NULL REFERENCES recurring_plans (id) ON DELETE RESTRICT,
  -- A plan change waits for the next period, so nobody is billed twice.
  next_plan_id         text REFERENCES recurring_plans (id) ON DELETE SET NULL,
  quantity             integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100000),
  price_override       numeric(14,2) CHECK (price_override IS NULL OR price_override > 0),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'cancelled')),
  start_date           date NOT NULL,
  trial_ends_on        date,
  next_billing_date    date,
  auto_issue           boolean NOT NULL DEFAULT true,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at         timestamptz,
  cancel_reason        text,
  notes                text NOT NULL DEFAULT '',
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_number_key ON subscriptions (org_id, number);
CREATE INDEX subscriptions_due_idx ON subscriptions (next_billing_date) WHERE status IN ('trialing', 'active', 'past_due');

CREATE TABLE subscription_invoices (
  subscription_id text NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  org_id          text NOT NULL,
  invoice_id      text NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, period_start)
);

CREATE TABLE finance_counters (
  org_id     text NOT NULL,
  kind       text NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, kind)
);
