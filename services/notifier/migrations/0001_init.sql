-- ════════════════════════════════════════════════════════════════════════════
-- NOTIFIER
--
-- Turns events other services publish into messages for the people who need
-- to act on them. It owns nothing else: a notification is a pointer to a
-- record in another app, never a copy of it.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE notifications (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  user_id     text NOT NULL,
  -- Which rule produced it, for filtering and for muting a kind later.
  kind        text NOT NULL,
  app         text NOT NULL,
  title       text NOT NULL,
  body        text,
  -- Where clicking it goes. Always a path inside the product.
  link        text,
  actor_id    text,
  -- The event it came from. Unique per recipient, so a redelivered event
  -- cannot notify anybody twice.
  event_id    text NOT NULL,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notifications_event_user_key ON notifications (event_id, user_id);
CREATE INDEX notifications_inbox_idx ON notifications (org_id, user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (org_id, user_id) WHERE read_at IS NULL;

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
