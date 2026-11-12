-- ════════════════════════════════════════════════════════════════════════════
-- MAIL SETTINGS — a workspace's own outgoing mail server.
--
-- Owners and admins enter their SMTP details (Gmail, Google Workspace, Zoho,
-- their host's mailbox) and the workspace's emails go out through it. The
-- password is sealed with a key derived from the service token.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE mail_settings (
  org_id          text PRIMARY KEY,
  host            text NOT NULL,
  port            integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username        text NOT NULL,
  password_sealed text NOT NULL,
  from_email      text NOT NULL,
  from_name       text,
  reply_to        text,
  enabled         boolean NOT NULL DEFAULT true,
  verified_at     timestamptz,
  updated_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
