-- ════════════════════════════════════════════════════════════════════════════
-- SURVEYS & FORMS — forms anyone can fill in from a link, and their responses.
-- Hosted in CRM so an enquiry becomes a lead in the same transaction.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE forms (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  -- [{ key, label, type, required, options[], maps_to, help }]
  fields           jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  -- The unguessable part of the public link. Rotating it retires old links.
  public_token     text NOT NULL,
  create_lead      boolean NOT NULL DEFAULT false,
  lead_source      text NOT NULL DEFAULT 'website'
                     CHECK (lead_source IN ('website','referral','campaign','event','partner')),
  lead_owner_id    text,
  thank_you_message text NOT NULL DEFAULT 'Thank you — we have received your response.',
  response_count   integer NOT NULL DEFAULT 0,
  last_response_at timestamptz,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

CREATE UNIQUE INDEX forms_token_key ON forms (public_token);
CREATE INDEX forms_org_idx ON forms (org_id, status, created_at DESC);

CREATE TABLE form_responses (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  form_id       text NOT NULL,
  answers       jsonb NOT NULL,
  contact_name  text,
  contact_email text,
  contact_phone text,
  lead_id       text,
  ip_hash       text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, form_id) REFERENCES forms (org_id, id) ON DELETE CASCADE
);

CREATE INDEX form_responses_idx ON form_responses (org_id, form_id, submitted_at DESC);
CREATE INDEX form_responses_ip_idx ON form_responses (form_id, ip_hash, submitted_at);
