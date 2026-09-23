-- ════════════════════════════════════════════════════════════════════════════
-- INVOICING — money owed, money received, and the tax in between.
--
-- Every amount is numeric(14,2) and every calculation happens in integer
-- paise before being written back. Floating point has no place in a ledger.
-- ════════════════════════════════════════════════════════════════════════════

-- Customers are a PROJECTION. CRM owns the record; this is the slim copy
-- invoicing needs, kept current by subscribing to crm.customer.* events.
-- Nothing here joins across a service boundary.
CREATE TABLE customers (
  id            text PRIMARY KEY,          -- the CRM company id
  org_id        text NOT NULL,
  name          text NOT NULL,
  email         text,
  phone         text,
  gstin         text,
  -- Two-digit GST state code. Drives CGST+SGST versus IGST.
  place_of_supply text,
  billing_address jsonb NOT NULL DEFAULT '{}',
  source        text NOT NULL DEFAULT 'crm',
  synced_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customers_org_idx      ON customers (org_id, lower(name));
CREATE INDEX customers_org_gstin_idx ON customers (org_id, gstin);

-- ── numbering ───────────────────────────────────────────────────────────────
-- Invoice numbers must be gap-free and sequential per financial year: a tax
-- authority treats a missing number as a destroyed invoice. The counter is a
-- row that is locked and incremented inside the issuing transaction.
CREATE TABLE number_sequences (
  org_id      text NOT NULL,
  kind        text NOT NULL,              -- 'invoice' | 'credit_note' | 'payment'
  fiscal_year text NOT NULL,              -- '2026-27'
  prefix      text NOT NULL,
  next_value  integer NOT NULL DEFAULT 1,
  padding     integer NOT NULL DEFAULT 4,
  PRIMARY KEY (org_id, kind, fiscal_year)
);

-- ── invoices ────────────────────────────────────────────────────────────────
CREATE TABLE invoices (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  number          text,                   -- assigned when issued, never while draft
  fiscal_year     text,
  customer_id     text REFERENCES customers (id) ON DELETE RESTRICT,
  customer_name   text NOT NULL,          -- snapshot: a renamed customer must
  customer_gstin  text,                   -- not rewrite an issued invoice
  billing_address jsonb NOT NULL DEFAULT '{}',
  place_of_supply text,

  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','issued','partially_paid','paid','overdue','void')),
  issue_date      date,
  due_date        date,
  terms_days      integer NOT NULL DEFAULT 30,
  currency        text NOT NULL DEFAULT 'INR',

  -- Totals, all derived from lines. Stored so an issued invoice is immutable
  -- even if a tax rate or rounding rule changes later.
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  discount_total  numeric(14,2) NOT NULL DEFAULT 0,
  taxable_total   numeric(14,2) NOT NULL DEFAULT 0,
  cgst_total      numeric(14,2) NOT NULL DEFAULT 0,
  sgst_total      numeric(14,2) NOT NULL DEFAULT 0,
  igst_total      numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  round_off       numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid     numeric(14,2) NOT NULL DEFAULT 0,
  amount_due      numeric(14,2) NOT NULL DEFAULT 0,

  is_interstate   boolean NOT NULL DEFAULT false,
  notes           text,
  terms           text,
  reference       text,
  -- Where it came from, so a deal-won invoice can be traced back.
  source          text NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','deal_won','recurring','import','api')),
  source_ref      text,
  issued_by       text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  void_reason     text
);

CREATE UNIQUE INDEX invoices_org_number_key ON invoices (org_id, number) WHERE number IS NOT NULL;
CREATE INDEX invoices_org_idx        ON invoices (org_id, created_at DESC);
CREATE INDEX invoices_org_status_idx ON invoices (org_id, status);
CREATE INDEX invoices_org_customer   ON invoices (org_id, customer_id);
CREATE INDEX invoices_org_due_idx    ON invoices (org_id, due_date)
  WHERE status IN ('issued','partially_paid','overdue');
-- One draft per won deal; re-delivery of the event must not duplicate it.
CREATE UNIQUE INDEX invoices_org_source_ref_key ON invoices (org_id, source, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE TABLE invoice_lines (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  invoice_id    text NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  position      integer NOT NULL DEFAULT 0,
  description   text NOT NULL,
  hsn_sac       text,
  quantity      numeric(12,3) NOT NULL DEFAULT 1,
  unit          text NOT NULL DEFAULT 'nos',
  unit_price    numeric(14,2) NOT NULL DEFAULT 0,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  tax_rate      numeric(5,2) NOT NULL DEFAULT 18,
  -- Derived, stored per line so a printed invoice can be reproduced exactly.
  line_subtotal numeric(14,2) NOT NULL DEFAULT 0,
  line_discount numeric(14,2) NOT NULL DEFAULT 0,
  line_taxable  numeric(14,2) NOT NULL DEFAULT 0,
  cgst_amount   numeric(14,2) NOT NULL DEFAULT 0,
  sgst_amount   numeric(14,2) NOT NULL DEFAULT 0,
  igst_amount   numeric(14,2) NOT NULL DEFAULT 0,
  line_total    numeric(14,2) NOT NULL DEFAULT 0
);

CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (org_id, invoice_id, position);

-- ── payments ────────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  number        text,
  customer_id   text REFERENCES customers (id) ON DELETE RESTRICT,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  -- What has been matched to invoices so far; the rest sits on account.
  allocated     numeric(14,2) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'INR',
  method        text NOT NULL DEFAULT 'bank_transfer'
                  CHECK (method IN ('cash','cheque','bank_transfer','upi','card','other')),
  reference     text,
  received_on   date NOT NULL DEFAULT current_date,
  notes         text,
  recorded_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_org_idx      ON payments (org_id, received_on DESC);
CREATE INDEX payments_org_customer ON payments (org_id, customer_id);

-- A payment may settle several invoices; an invoice may take several payments.
CREATE TABLE payment_allocations (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  payment_id  text NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  invoice_id  text NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payment_allocations_key ON payment_allocations (payment_id, invoice_id);
CREATE INDEX payment_allocations_invoice_idx ON payment_allocations (org_id, invoice_id);

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

-- Consumed event ids, so a redelivered event is a no-op rather than a
-- duplicate invoice. At-least-once delivery demands this.
CREATE TABLE consumed_events (
  event_id    text PRIMARY KEY,
  event_type  text NOT NULL,
  org_id      text,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_touch BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
