-- ════════════════════════════════════════════════════════════════════════════
-- The employee portal role.
--
-- Seeded into every existing workspace, not just new ones — the same reason
-- 0002 backfilled patterns. A role that only appears in workspaces created
-- after today is a feature half the customers cannot use.
--
-- It grants `*.self.*` and nothing else. Services resolve `self` from the
-- signed-in user, so this role cannot be pointed at another person's record.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO roles (id, org_id, slug, name, description, is_system, is_protected,
                   implicit_all, permission_patterns, denied_patterns)
SELECT
  -- Deterministic id from the org id, so re-running this is a no-op and the
  -- role never appears twice in a workspace.
  'rol_' || substr(md5(o.id || ':employee'), 1, 26),
  o.id,
  'employee',
  'Employee',
  'Their own payslips, attendance, leave and documents. Nothing else.',
  true, true, false,
  '{"*.self.*"}',
  '{"billing.*.*","core.*.*","catalog.*.*"}'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.org_id = o.id AND r.slug = 'employee'
);

-- Every workspace that gains a role has had its permission surface change,
-- so live tokens must be re-minted rather than trusted.
UPDATE organizations SET epoch = epoch + 1
WHERE EXISTS (SELECT 1 FROM roles r WHERE r.org_id = organizations.id AND r.slug = 'employee');
