-- ════════════════════════════════════════════════════════════════════════════
-- EXPENSES — claims staff make for money they spent on the company's behalf.
-- Hosted with payroll because a reimbursement is money paid to a person.
-- Money in integer paise throughout.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE expense_categories (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL,
  name               text NOT NULL,
  -- Per person, per calendar month. Exceeding it warns the approver; it does
  -- not block the claim, because the approver may still say yes.
  monthly_limit_paise bigint CHECK (monthly_limit_paise > 0),
  requires_receipt   boolean NOT NULL DEFAULT true,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

CREATE UNIQUE INDEX expense_categories_name_key ON expense_categories (org_id, lower(name));

CREATE TABLE expense_counters (
  org_id     text PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);

CREATE TABLE expense_claims (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  number          text NOT NULL,
  user_id         text NOT NULL,
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'reimbursed')),
  total_paise     bigint NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
  policy_warnings jsonb NOT NULL DEFAULT '[]',
  submitted_at    timestamptz,
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,
  reimbursed_by   text,
  reimbursed_at   timestamptz,
  payment_reference text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (org_id, id)
);

CREATE INDEX expense_claims_user_idx ON expense_claims (org_id, user_id, created_at DESC);
CREATE INDEX expense_claims_status_idx ON expense_claims (org_id, status, submitted_at);

CREATE TABLE expense_lines (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL,
  claim_id            text NOT NULL,
  spent_on            date NOT NULL,
  category_id         text NOT NULL,
  merchant            text,
  description         text NOT NULL DEFAULT '',
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  receipt_url         text,
  receipt_document_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, claim_id) REFERENCES expense_claims (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, category_id) REFERENCES expense_categories (org_id, id)
);

CREATE INDEX expense_lines_claim_idx ON expense_lines (org_id, claim_id);
