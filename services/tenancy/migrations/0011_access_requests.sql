-- People ask for what they cannot open: an app, or one ability inside an app
-- they already use ("Lead sources"). An owner or admin approves or declines;
-- approving shares the app or grants the ability to that one person.
CREATE TABLE access_requests (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  member_id    text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  app_slug     text,
  permission   text,
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by   text,
  decided_at   timestamptz,
  decision_note text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (app_slug IS NOT NULL OR permission IS NOT NULL OR note IS NOT NULL)
);
CREATE INDEX access_requests_org_idx ON access_requests (org_id, status, created_at DESC);
CREATE INDEX access_requests_member_idx ON access_requests (member_id, created_at DESC);
