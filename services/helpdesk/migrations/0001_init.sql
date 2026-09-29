-- ════════════════════════════════════════════════════════════════════════════
-- HELPDESK — tickets, the conversation on each, and the SLA they run against.
-- KNOWLEDGE — categories and articles. Hosted here because articles are what
-- answer tickets; the two stay separate apps with separate permissions.
-- ════════════════════════════════════════════════════════════════════════════

-- Ticket numbers are per workspace and never reused: #1, #2, …
CREATE TABLE ticket_counters (
  org_id     text PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);

-- How fast each priority must be answered and resolved, in minutes.
CREATE TABLE sla_policies (
  org_id                   text NOT NULL,
  priority                 text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  first_response_minutes   integer NOT NULL CHECK (first_response_minutes > 0),
  resolution_minutes       integer NOT NULL CHECK (resolution_minutes > 0),
  updated_by               text,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, priority)
);

CREATE TABLE tickets (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL,
  number              integer NOT NULL,
  subject             text NOT NULL,
  description         text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'pending', 'on_hold', 'resolved', 'closed')),
  priority            text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  channel             text NOT NULL DEFAULT 'web'
                        CHECK (channel IN ('email', 'phone', 'whatsapp', 'web', 'walk_in', 'social', 'other')),
  category            text,
  tags                text[] NOT NULL DEFAULT '{}',
  requester_name      text,
  requester_email     text,
  requester_phone     text,
  assignee_id         text,
  created_by          text NOT NULL,
  -- SLA clocks, fixed from the policy when the ticket is opened (or its
  -- priority changes), so a later policy edit never rewrites a promise.
  first_response_due  timestamptz,
  resolution_due      timestamptz,
  first_response_at   timestamptz,
  resolved_at         timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  UNIQUE (org_id, id)
);

CREATE INDEX tickets_queue_idx ON tickets (org_id, status, priority, resolution_due);
CREATE INDEX tickets_assignee_idx ON tickets (org_id, assignee_id, status);
CREATE INDEX tickets_requester_idx ON tickets (org_id, lower(requester_email));

-- The conversation: replies the requester sees, notes only the team sees.
CREATE TABLE ticket_messages (
  id         text PRIMARY KEY,
  org_id     text NOT NULL,
  ticket_id  text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('reply', 'note', 'event')),
  body       text NOT NULL,
  author_id  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, ticket_id) REFERENCES tickets (org_id, id) ON DELETE CASCADE
);

CREATE INDEX ticket_messages_idx ON ticket_messages (org_id, ticket_id, created_at);

-- ── knowledge base ─────────────────────────────────────────────────────────
CREATE TABLE kb_categories (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

CREATE UNIQUE INDEX kb_categories_name_key ON kb_categories (org_id, lower(name));

CREATE TABLE kb_articles (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  category_id  text,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  tags         text[] NOT NULL DEFAULT '{}',
  views        integer NOT NULL DEFAULT 0,
  author_id    text NOT NULL,
  updated_by   text,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                 setweight(to_tsvector('simple', coalesce(body, '')), 'B')) STORED,
  FOREIGN KEY (org_id, category_id) REFERENCES kb_categories (org_id, id) ON DELETE SET NULL (category_id)
);

CREATE INDEX kb_articles_list_idx ON kb_articles (org_id, status, updated_at DESC);
CREATE INDEX kb_articles_search_idx ON kb_articles USING gin (search);

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
