CREATE TABLE email_change_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id),
  org_id text,
  old_email text NOT NULL,
  new_email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_changes_pending_user_key ON email_change_requests(user_id)
  WHERE consumed_at IS NULL;
