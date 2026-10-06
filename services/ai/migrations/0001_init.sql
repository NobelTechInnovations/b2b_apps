CREATE TABLE action_log (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL,
  connection_id text,
  action_id text NOT NULL,
  source text NOT NULL CHECK(source IN ('mcp','assistant')),
  status text NOT NULL DEFAULT 'started',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX action_log_company ON action_log(org_id, user_id, created_at DESC);
CREATE TABLE proposals (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL,
  action jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executing','completed','failed')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_expiry ON proposals(expires_at);
