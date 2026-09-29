-- ════════════════════════════════════════════════════════════════════════════
-- Seat-based plans, prepaid (advance) billing and payments.
--
-- Apps are no longer priced one by one. A plan buys a number of seats and a
-- number of apps; seats and apps beyond that are flat add-ons. Every period is
-- invoiced BEFORE it starts and must be paid for access to continue.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE plans
  -- NULL means unlimited apps.
  ADD COLUMN IF NOT EXISTS included_app_count integer,
  ADD COLUMN IF NOT EXISTS extra_app_price numeric(12,2) NOT NULL DEFAULT 0,
  -- Months charged for an annual term (10 = two months free).
  ADD COLUMN IF NOT EXISTS annual_months integer NOT NULL DEFAULT 10 CHECK (annual_months BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS is_retired boolean NOT NULL DEFAULT false;

-- `incomplete`: created with no trial and not paid yet — nothing unlocks until
-- the first invoice is paid.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('trialing', 'incomplete', 'active', 'past_due', 'canceled', 'paused'));

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'subscription'
    CHECK (kind IN ('subscription', 'renewal', 'adjustment')),
  ADD COLUMN IF NOT EXISTS billing_cycle text CHECK (billing_cycle IN ('monthly', 'annual')),
  ADD COLUMN IF NOT EXISTS seats integer,
  ADD COLUMN IF NOT EXISTS app_slugs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS invoices_open_idx ON invoices (org_id, status, due_at) WHERE status = 'open';

-- Gap-free numbering per financial year, e.g. NX/2026-27/000042.
CREATE TABLE IF NOT EXISTS invoice_counters (
  fiscal_year text PRIMARY KEY,
  last_value  integer NOT NULL DEFAULT 0
);

-- One row per payment attempt with a provider. The provider's ids are unique,
-- so a verified callback and a webhook for the same payment settle it once.
CREATE TABLE IF NOT EXISTS payments (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL,
  invoice_id          text NOT NULL REFERENCES invoices (id),
  provider            text NOT NULL CHECK (provider IN ('razorpay', 'test', 'manual')),
  provider_order_id   text,
  provider_payment_id text,
  amount              numeric(12,2) NOT NULL,
  currency            text NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'captured', 'failed')),
  error               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  captured_at         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_payment_key
  ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_order_key
  ON payments (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (org_id, invoice_id);

-- Apps are bought through the plan now, so per-app prices are all zero.
UPDATE app_prices SET price_monthly = 0, price_annual = 0, billing_unit = 'org', updated_at = now();
UPDATE subscription_items SET unit_price = 0 WHERE removed_at IS NULL;
