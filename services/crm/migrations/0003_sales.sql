-- ════════════════════════════════════════════════════════════════════════════
-- SALES & MARKETING — Quotations & Orders, Partner Portal, Marketing, Social.
-- They live with CRM because every one of them starts from, or ends in, a
-- company, a contact, a lead or a deal.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE sales_counters (
  org_id     text NOT NULL,
  kind       text NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, kind)
);

CREATE TABLE sales_settings (
  org_id                     text PRIMARY KEY,
  -- Any line discounted beyond this needs a manager's approval before sending.
  approval_discount_percent  numeric(5,2) NOT NULL DEFAULT 15,
  quote_validity_days        integer NOT NULL DEFAULT 15,
  default_terms              text NOT NULL DEFAULT 'Prices are exclusive of GST unless stated. Valid for the period shown.',
  updated_by                 text,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- ── quotations & orders ─────────────────────────────────────────────────────
CREATE TABLE quote_templates (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  name          text NOT NULL,
  title         text NOT NULL DEFAULT '',
  terms         text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  validity_days integer NOT NULL DEFAULT 15 CHECK (validity_days BETWEEN 1 AND 365),
  lines         jsonb NOT NULL DEFAULT '[]',
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotations (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  number           text NOT NULL,
  title            text NOT NULL DEFAULT '',
  company_id       text REFERENCES companies (id) ON DELETE SET NULL,
  contact_id       text REFERENCES contacts (id) ON DELETE SET NULL,
  deal_id          text REFERENCES deals (id) ON DELETE SET NULL,
  customer_name    text NOT NULL,
  customer_email   text,
  customer_gstin   text,
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired', 'converted')),
  issue_date       date NOT NULL DEFAULT current_date,
  valid_until      date NOT NULL,
  currency         text NOT NULL DEFAULT 'INR',
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  discount_total   numeric(14,2) NOT NULL DEFAULT 0,
  tax_total        numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  max_discount     numeric(5,2) NOT NULL DEFAULT 0,
  terms            text NOT NULL DEFAULT '',
  notes            text NOT NULL DEFAULT '',
  -- The customer's link. Opaque, unguessable, and rotatable.
  public_token     text NOT NULL,
  approved_by      text,
  approved_at      timestamptz,
  sent_at          timestamptz,
  viewed_at        timestamptz,
  accepted_at      timestamptz,
  accepted_by_name text,
  declined_at      timestamptz,
  decline_reason   text,
  owner_user_id    text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quotations_number_key ON quotations (org_id, number);
CREATE UNIQUE INDEX quotations_token_key ON quotations (public_token);
CREATE INDEX quotations_status_idx ON quotations (org_id, status, created_at DESC);

CREATE TABLE quotation_lines (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  quotation_id     text NOT NULL REFERENCES quotations (id) ON DELETE CASCADE,
  position         integer NOT NULL DEFAULT 0,
  product_id       text,
  description      text NOT NULL,
  quantity         numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price       numeric(14,2) NOT NULL DEFAULT 0,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  tax_rate         numeric(5,2) NOT NULL DEFAULT 18,
  line_total       numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX quotation_lines_idx ON quotation_lines (org_id, quotation_id, position);

CREATE TABLE sales_orders (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  number         text NOT NULL,
  quotation_id   text REFERENCES quotations (id) ON DELETE SET NULL,
  company_id     text REFERENCES companies (id) ON DELETE SET NULL,
  customer_name  text NOT NULL,
  customer_email text,
  customer_gstin text,
  status         text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'delivered', 'invoiced', 'cancelled')),
  order_date     date NOT NULL DEFAULT current_date,
  subtotal       numeric(14,2) NOT NULL DEFAULT 0,
  discount_total numeric(14,2) NOT NULL DEFAULT 0,
  tax_total      numeric(14,2) NOT NULL DEFAULT 0,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  delivered_at   timestamptz,
  invoice_id     text,
  invoice_number text,
  notes          text NOT NULL DEFAULT '',
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sales_orders_number_key ON sales_orders (org_id, number);
CREATE UNIQUE INDEX sales_orders_quote_key ON sales_orders (org_id, quotation_id) WHERE quotation_id IS NOT NULL;

CREATE TABLE sales_order_lines (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  order_id         text NOT NULL REFERENCES sales_orders (id) ON DELETE CASCADE,
  position         integer NOT NULL DEFAULT 0,
  product_id       text,
  description      text NOT NULL,
  quantity         numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price       numeric(14,2) NOT NULL DEFAULT 0,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  tax_rate         numeric(5,2) NOT NULL DEFAULT 18,
  line_total       numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX sales_order_lines_idx ON sales_order_lines (org_id, order_id, position);

-- ── partners ────────────────────────────────────────────────────────────────
CREATE TABLE partners (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL,
  name               text NOT NULL,
  tier               text NOT NULL DEFAULT 'registered' CHECK (tier IN ('registered', 'silver', 'gold', 'platinum')),
  commission_percent numeric(5,2) NOT NULL DEFAULT 10 CHECK (commission_percent BETWEEN 0 AND 100),
  contact_name       text,
  email              text,
  phone              text,
  city               text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  portal_token       text NOT NULL,
  notes              text NOT NULL DEFAULT '',
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partners_name_key ON partners (org_id, lower(name));
CREATE UNIQUE INDEX partners_token_key ON partners (portal_token);

CREATE TABLE partner_deals (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  number           text NOT NULL,
  partner_id       text NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
  customer_company text NOT NULL,
  customer_contact text,
  customer_email   text,
  customer_phone   text,
  expected_value   numeric(14,2) NOT NULL DEFAULT 0,
  expected_close   date,
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'won', 'lost')),
  source           text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'internal')),
  decision_note    text,
  lead_id          text,
  won_value        numeric(14,2),
  decided_by       text,
  decided_at       timestamptz,
  ip_hash          text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_deals_number_key ON partner_deals (org_id, number);
CREATE INDEX partner_deals_partner_idx ON partner_deals (org_id, partner_id, created_at DESC);

CREATE TABLE partner_commissions (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  partner_id      text NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
  partner_deal_id text NOT NULL REFERENCES partner_deals (id) ON DELETE CASCADE,
  base_amount     numeric(14,2) NOT NULL,
  percent         numeric(5,2) NOT NULL,
  amount          numeric(14,2) NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
  reference       text,
  approved_by     text,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_commissions_deal_key ON partner_commissions (partner_deal_id);

CREATE TABLE partner_collateral (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  title       text NOT NULL,
  url         text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── marketing ───────────────────────────────────────────────────────────────
CREATE TABLE marketing_segments (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT 'leads' CHECK (source IN ('leads', 'contacts')),
  -- Filters over the source: status, lead source, rating, tag, created after.
  rules       jsonb NOT NULL DEFAULT '{}',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_templates (
  id         text PRIMARY KEY,
  org_id     text NOT NULL,
  name       text NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_campaigns (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  name          text NOT NULL,
  segment_id    text REFERENCES marketing_segments (id) ON DELETE SET NULL,
  subject       text NOT NULL DEFAULT '',
  body          text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  recipients    integer NOT NULL DEFAULT 0,
  suppressed    integer NOT NULL DEFAULT 0,
  opened        integer NOT NULL DEFAULT 0,
  clicked       integer NOT NULL DEFAULT 0,
  unsubscribed  integer NOT NULL DEFAULT 0,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_recipients (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  campaign_id text NOT NULL REFERENCES marketing_campaigns (id) ON DELETE CASCADE,
  email       text NOT NULL,
  name        text,
  lead_id     text,
  contact_id  text,
  token       text NOT NULL,
  opened_at   timestamptz,
  clicked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX marketing_recipients_email_key ON marketing_recipients (campaign_id, lower(email));
CREATE UNIQUE INDEX marketing_recipients_token_key ON marketing_recipients (token);

CREATE TABLE marketing_unsubscribes (
  org_id      text NOT NULL,
  email       text NOT NULL,
  campaign_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, email)
);

-- ── social ──────────────────────────────────────────────────────────────────
CREATE TABLE social_accounts (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  network      text NOT NULL CHECK (network IN ('facebook', 'instagram', 'linkedin', 'x', 'youtube', 'whatsapp', 'google_business')),
  handle       text NOT NULL,
  display_name text,
  profile_url  text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX social_accounts_key ON social_accounts (org_id, network, lower(handle));

CREATE TABLE social_posts (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  content       text NOT NULL,
  account_ids   text[] NOT NULL DEFAULT '{}',
  media_urls    text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'scheduled', 'published', 'failed')),
  scheduled_at  timestamptz,
  reminded_at   timestamptz,
  published_at  timestamptz,
  published_urls jsonb NOT NULL DEFAULT '{}',
  approved_by   text,
  campaign      text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_posts_schedule_idx ON social_posts (scheduled_at) WHERE status = 'scheduled';

CREATE TABLE social_inbox (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  account_id    text REFERENCES social_accounts (id) ON DELETE SET NULL,
  kind          text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'mention', 'message', 'review')),
  author_name   text NOT NULL,
  author_handle text,
  body          text NOT NULL,
  external_url  text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replied', 'closed')),
  reply         text,
  replied_by    text,
  replied_at    timestamptz,
  lead_id       text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_inbox_status_idx ON social_inbox (org_id, status, received_at DESC);
