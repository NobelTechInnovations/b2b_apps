-- The email log: every message, what happened to it, and where.
--
-- `server` and `transport` say which machine handled it and through which
-- mail service, so "it was written to a log instead" can be traced to a
-- server that has no SMTP settings. Temporary failures stay visible as
-- `retrying` with their error instead of disappearing until the next try.
ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_status_check;
ALTER TABLE emails ADD CONSTRAINT emails_status_check
  CHECK (status IN ('sending', 'sent', 'logged', 'failed', 'retrying'));

ALTER TABLE emails
  ADD COLUMN subject    text,
  ADD COLUMN server     text,
  ADD COLUMN transport  text,
  ADD COLUMN attempts   integer NOT NULL DEFAULT 1,
  ADD COLUMN response   text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS emails_status_idx ON emails (org_id, status, created_at DESC);
