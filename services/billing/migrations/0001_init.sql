-- ════════════════════════════════════════════════════════════════════════════
-- BILLING — plans, subscriptions and the entitlements that gate every app.
-- No price is ever hardcoded in application logic; it all lives here.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE plans (
  slug            text PRIMARY KEY,
  name            text NOT NULL,
  tagline         text,
  description     text,
  base_price_monthly numeric(12,2) NOT NULL DEFAULT 0,
  base_price_annual  numeric(12,2) NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'INR',
  included_users  integer NOT NULL DEFAULT 5,
  extra_user_price numeric(12,2) NOT NULL DEFAULT 0,
  max_users       integer,
  storage_gb      integer NOT NULL DEFAULT 5,
  trial_days      integer NOT NULL DEFAULT 14,
  features        jsonb NOT NULL DEFAULT '[]',
  is_public       boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Apps bundled into a plan at no extra charge.
CREATE TABLE plan_apps (
  plan_slug text NOT NULL REFERENCES plans (slug) ON DELETE CASCADE,
  app_slug  text NOT NULL,
  PRIMARY KEY (plan_slug, app_slug)
);

-- Per-app pricing. Overrides the default in the app registry when present.
CREATE TABLE app_prices (
  app_slug       text PRIMARY KEY,
  price_monthly  numeric(12,2) NOT NULL,
  price_annual   numeric(12,2) NOT NULL,
  currency       text NOT NULL DEFAULT 'INR',
  billing_unit   text NOT NULL DEFAULT 'user' CHECK (billing_unit IN ('user', 'org')),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── subscriptions ───────────────────────────────────────────────────────────
CREATE TABLE subscriptions (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL,
  plan_slug          text NOT NULL REFERENCES plans (slug),
  status             text NOT NULL DEFAULT 'trialing'
                       CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'paused')),
  billing_cycle      text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
  currency           text NOT NULL DEFAULT 'INR',
  seats              integer NOT NULL DEFAULT 5,
  trial_ends_at      timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at        timestamptz,
  cancellation_reason text,
  provider           text NOT NULL DEFAULT 'manual',
  provider_ref       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX subscriptions_org_active_key ON subscriptions (org_id)
  WHERE status <> 'canceled';
CREATE INDEX subscriptions_status_idx ON subscriptions (status, current_period_end);

-- One line per purchased app. This is what the customer actually buys.
CREATE TABLE subscription_items (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  subscription_id text NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  app_slug        text NOT NULL,
  quantity        integer NOT NULL DEFAULT 1,
  unit_price      numeric(12,2) NOT NULL,
  billing_unit    text NOT NULL DEFAULT 'user',
  source          text NOT NULL DEFAULT 'addon' CHECK (source IN ('plan', 'addon', 'trial')),
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);

CREATE UNIQUE INDEX subscription_items_key ON subscription_items (subscription_id, app_slug)
  WHERE removed_at IS NULL;
CREATE INDEX subscription_items_org_idx ON subscription_items (org_id) WHERE removed_at IS NULL;

-- ── entitlements: the read model every gate consults ────────────────────────
CREATE TABLE app_entitlements (
  org_id     text NOT NULL,
  app_slug   text NOT NULL,
  status     text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'trialing', 'grace', 'expired')),
  seats      integer,
  source     text NOT NULL DEFAULT 'subscription',
  starts_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (org_id, app_slug)
);

CREATE INDEX app_entitlements_org_idx ON app_entitlements (org_id) WHERE status <> 'expired';

CREATE TABLE feature_entitlements (
  org_id     text NOT NULL,
  feature    text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  limit_value integer,
  PRIMARY KEY (org_id, feature)
);

-- ── invoices ────────────────────────────────────────────────────────────────
CREATE TABLE invoices (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  subscription_id text REFERENCES subscriptions (id) ON DELETE SET NULL,
  number          text NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency        text NOT NULL DEFAULT 'INR',
  subtotal        numeric(12,2) NOT NULL DEFAULT 0,
  tax_amount      numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid     numeric(12,2) NOT NULL DEFAULT 0,
  period_start    timestamptz,
  period_end      timestamptz,
  due_at          timestamptz,
  paid_at         timestamptz,
  lines           jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invoices_number_key ON invoices (number);
CREATE INDEX invoices_org_idx ON invoices (org_id, created_at DESC);

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

CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
