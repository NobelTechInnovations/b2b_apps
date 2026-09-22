-- ════════════════════════════════════════════════════════════════════════════
-- CATALOG — which apps exist, and which ones each workspace has switched on.
-- The definitions themselves live in @nexus/contracts and are synced in at
-- boot, so a deploy is all it takes to publish a new app to the marketplace.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE apps (
  slug          text PRIMARY KEY,
  name          text NOT NULL,
  tagline       text,
  description   text,
  category      text NOT NULL,
  icon          text,
  color         text,
  service       text NOT NULL,
  is_core       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available', 'coming_soon', 'beta', 'deprecated')),
  version       text NOT NULL DEFAULT '1.0.0',
  price         jsonb NOT NULL DEFAULT '{}',
  highlights    jsonb NOT NULL DEFAULT '[]',
  features      jsonb NOT NULL DEFAULT '[]',
  permissions   jsonb NOT NULL DEFAULT '[]',
  nav           jsonb NOT NULL DEFAULT '[]',
  widgets       jsonb NOT NULL DEFAULT '[]',
  dependencies  jsonb NOT NULL DEFAULT '[]',
  sort_order    integer NOT NULL DEFAULT 100,
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX apps_category_idx ON apps (category, sort_order);

-- ── per-workspace install state ─────────────────────────────────────────────
CREATE TABLE organization_apps (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  app_slug        text NOT NULL REFERENCES apps (slug) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'installed'
                    CHECK (status IN ('installed', 'suspended', 'uninstalled')),
  -- Installed because the workspace bought it, or because another app needs it.
  install_reason  text NOT NULL DEFAULT 'purchased'
                    CHECK (install_reason IN ('purchased', 'dependency', 'trial', 'included')),
  settings        jsonb NOT NULL DEFAULT '{}',
  installed_by    text,
  installed_at    timestamptz NOT NULL DEFAULT now(),
  uninstalled_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organization_apps_key ON organization_apps (org_id, app_slug);
CREATE INDEX organization_apps_org_idx ON organization_apps (org_id)
  WHERE status = 'installed';

-- Records why an app is present, so uninstalling a parent can clean up.
CREATE TABLE app_dependency_links (
  org_id       text NOT NULL,
  app_slug     text NOT NULL,
  required_by  text NOT NULL,
  PRIMARY KEY (org_id, app_slug, required_by)
);

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

CREATE TRIGGER organization_apps_touch BEFORE UPDATE ON organization_apps
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
