-- ════════════════════════════════════════════════════════════════════════════
-- TENANCY — organizations, membership, roles and permissions.
-- The authority on "who is allowed to do what, where".
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE organizations (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  slug          text NOT NULL,
  legal_name    text,
  logo_url      text,
  website       text,
  industry      text,
  size_band     text CHECK (size_band IN ('1-10', '11-50', '51-200', '201-500', '500+')),
  country       text NOT NULL DEFAULT 'IN',
  currency      text NOT NULL DEFAULT 'INR',
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  fiscal_year_start smallint NOT NULL DEFAULT 4 CHECK (fiscal_year_start BETWEEN 1 AND 12),
  tax_id        text,
  address       jsonb NOT NULL DEFAULT '{}',
  settings      jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'archived')),
  -- Bumped whenever membership or role grants change. Access tokens carry the
  -- epoch they were minted at; a stale epoch forces a silent refresh, which is
  -- how permission revocation takes effect almost immediately.
  epoch         integer NOT NULL DEFAULT 1,
  owner_user_id text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug) WHERE status <> 'archived';
CREATE INDEX organizations_owner_idx ON organizations (owner_user_id);

-- ── roles ───────────────────────────────────────────────────────────────────
CREATE TABLE roles (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  slug        text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  is_protected boolean NOT NULL DEFAULT false,
  implicit_all boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX roles_org_slug_key ON roles (org_id, slug);

CREATE TABLE role_permissions (
  org_id     text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  role_id    text NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE INDEX role_permissions_org_idx ON role_permissions (org_id, role_id);

-- ── membership ──────────────────────────────────────────────────────────────
CREATE TABLE members (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'invited', 'suspended', 'removed')),
  title         text,
  employee_ref  text,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX members_org_user_key ON members (org_id, user_id) WHERE status <> 'removed';
CREATE INDEX members_user_idx ON members (user_id) WHERE status = 'active';
CREATE INDEX members_org_idx  ON members (org_id, status);

CREATE TABLE member_roles (
  org_id    text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  role_id   text NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text,
  PRIMARY KEY (member_id, role_id)
);

CREATE INDEX member_roles_org_idx  ON member_roles (org_id);
CREATE INDEX member_roles_role_idx ON member_roles (role_id);

-- Direct grants and denials, layered on top of roles. Denials always win.
CREATE TABLE member_permissions (
  org_id     text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  member_id  text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  permission text NOT NULL,
  effect     text NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  PRIMARY KEY (member_id, permission)
);

-- ── teams ───────────────────────────────────────────────────────────────────
CREATE TABLE teams (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  lead_member_id text REFERENCES members (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX teams_org_slug_key ON teams (org_id, slug);

CREATE TABLE team_members (
  org_id    text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  team_id   text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, member_id)
);

-- ── invitations ─────────────────────────────────────────────────────────────
CREATE TABLE invitations (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email        text NOT NULL,
  token_hash   text NOT NULL,
  role_ids     text[] NOT NULL DEFAULT '{}',
  title        text,
  message      text,
  invited_by   text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invitations_token_key ON invitations (token_hash);
CREATE UNIQUE INDEX invitations_pending_key ON invitations (org_id, lower(email))
  WHERE status = 'pending';
CREATE INDEX invitations_org_idx ON invitations (org_id, status);

-- ── outbox ──────────────────────────────────────────────────────────────────
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

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER members_touch BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER roles_touch BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
