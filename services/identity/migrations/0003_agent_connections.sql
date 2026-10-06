-- One MCP credential belongs to one person in exactly one company. Only its
-- SHA-256 digest is stored. A dedicated session participates in global revocation.
CREATE TABLE agent_connections (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  session_id text NOT NULL REFERENCES sessions(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  apps text[] NOT NULL,
  allow_write boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_connections_owner ON agent_connections(org_id, user_id, created_at DESC);
