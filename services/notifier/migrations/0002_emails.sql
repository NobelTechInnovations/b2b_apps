-- Every email the platform sends, once. Events are delivered at least once,
-- so the unique key is what stops a redelivered invitation arriving twice.
CREATE TABLE IF NOT EXISTS emails (
  id          text PRIMARY KEY,
  event_id    text NOT NULL,
  to_address  text NOT NULL,
  template    text NOT NULL,
  org_id      text,
  status      text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'logged', 'failed')),
  provider_id text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, to_address)
);
CREATE INDEX IF NOT EXISTS emails_org_idx ON emails (org_id, created_at DESC);
