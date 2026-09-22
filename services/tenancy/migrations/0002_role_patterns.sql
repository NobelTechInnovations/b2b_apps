-- ════════════════════════════════════════════════════════════════════════════
-- System roles hold PATTERNS, not a frozen snapshot of permissions.
--
-- Previously `admin` and `member` were seeded by expanding wildcards against
-- the app registry at the moment the workspace was created. That snapshot went
-- stale the instant a new app shipped: an admin in an older workspace could
-- never be granted permissions for it.
--
-- Storing the patterns and expanding them at resolution time means every
-- workspace picks up new apps automatically, and cuts ~800 seeded rows per
-- organization down to a handful.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS permission_patterns text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS denied_patterns     text[] NOT NULL DEFAULT '{}';

-- Backfill existing workspaces with the patterns their system roles represent.
UPDATE roles SET
  permission_patterns = '{"*.*.view","*.*.create","*.*.edit","*.*.delete","*.*.manage","*.*.approve","*.*.export"}',
  denied_patterns     = '{"billing.*.*"}'
WHERE is_system = true AND slug = 'admin';

UPDATE roles SET
  permission_patterns = '{"*.*.view","*.*.create","*.*.edit"}',
  denied_patterns     = '{"billing.*.*","*.*.delete","core.settings.manage","core.roles.manage","catalog.apps.manage"}'
WHERE is_system = true AND slug = 'member';

UPDATE roles SET
  permission_patterns = '{"*.*.view"}',
  denied_patterns     = '{"billing.*.*","core.*.*"}'
WHERE is_system = true AND slug = 'guest';

-- The expanded rows are now redundant for system roles. Custom roles keep
-- their explicit grants — those are a deliberate choice by the customer.
DELETE FROM role_permissions rp
  USING roles r
 WHERE rp.role_id = r.id
   AND r.is_system = true
   AND r.implicit_all = false;
