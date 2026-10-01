import { allPermissions, SYSTEM_ROLES } from '@nexus/contracts';
import { id } from '@nexus/db-kit';

/**
 * Permission strings are `<app>.<resource>.<action>`. Patterns may use `*` in
 * any of the three positions, so `crm.*.view` and `*.*.delete` both work.
 */
export function matches(pattern, permission) {
  if (pattern === permission) return true;
  const p = pattern.split('.');
  const t = permission.split('.');
  if (p.length !== 3 || t.length !== 3) return false;
  return p.every((part, i) => part === '*' || part === t[i]);
}

export function expand(patterns = [], universe = allPermissions()) {
  const out = new Set();
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      out.add(pattern);
      continue;
    }
    for (const permission of universe) {
      if (matches(pattern, permission)) out.add(permission);
    }
  }
  return out;
}

/** Grants minus denies, both wildcard-aware. */
export function permissionsForRoleTemplate(template) {
  if (template.implicit_all) return new Set(allPermissions());
  const granted = expand(template.grants ?? []);
  for (const denyPattern of template.denies ?? []) {
    for (const permission of [...granted]) {
      if (matches(denyPattern, permission)) granted.delete(permission);
    }
  }
  return granted;
}

/** Seed the four system roles into a brand-new organization. */
export async function seedSystemRoles(tx, orgId) {
  const created = {};

  for (const template of SYSTEM_ROLES) {
    const role = await tx.one(
      `INSERT INTO roles (id, org_id, slug, name, description, is_system, is_protected,
                          implicit_all, permission_patterns, denied_patterns)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9) RETURNING *`,
      [
        id('rol'),
        orgId,
        template.slug,
        template.name,
        template.description,
        template.protected ?? false,
        template.implicit_all ?? false,
        template.grants ?? [],
        template.denies ?? [],
      ],
    );
    created[template.slug] = role;
  }

  return created;
}

/**
 * The effective permission set for one member.
 *
 * owner            → everything, always
 * role grants      → union of every role's permissions
 * direct allows    → added on top
 * direct denies    → removed last, so a denial can never be out-voted
 *
 * The result is further intersected with the org's entitled apps by the
 * gateway, so buying HR is what makes HR permissions real.
 */
export async function resolveMemberPermissions(db, { orgId, memberId }) {
  const access = await db.one(`SELECT app_access FROM members WHERE id = $1 AND org_id = $2`, [memberId, orgId]);
  const roleRows = await db.rows(
    `SELECT r.id, r.slug AS role_slug, r.implicit_all, r.permission_patterns, r.denied_patterns
       FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
      WHERE mr.member_id = $1 AND mr.org_id = $2`,
    [memberId, orgId],
  );

  const roles = [...new Set(roleRows.map((r) => r.role_slug))];
  const isOwner = roleRows.some((r) => r.implicit_all);

  if (isOwner) {
    return { roles, permissions: new Set(allPermissions()), isOwner: true, appAccess: null };
  }

  const grantRows = roleRows.length
    ? await db.rows(
        `SELECT permission FROM role_permissions WHERE role_id = ANY($1) AND org_id = $2`,
        [roleRows.map((r) => r.id), orgId],
      )
    : [];

  // Explicit grants a customer chose, plus whatever the role's patterns cover
  // right now — so a workspace picks up newly shipped apps without reseeding.
  const permissions = new Set(grantRows.map((r) => r.permission));

  for (const role of roleRows) {
    for (const permission of expand(role.permission_patterns ?? [])) {
      permissions.add(permission);
    }
  }

  for (const role of roleRows) {
    for (const pattern of role.denied_patterns ?? []) {
      for (const permission of [...permissions]) {
        if (matches(pattern, permission)) permissions.delete(permission);
      }
    }
  }

  const direct = await db.rows(
    `SELECT permission, effect FROM member_permissions WHERE member_id = $1 AND org_id = $2`,
    [memberId, orgId],
  );

  for (const row of direct) if (row.effect === 'allow') permissions.add(row.permission);
  for (const row of direct) if (row.effect === 'deny') permissions.delete(row.permission);

  // Administrators run the workspace, so no app is hidden from them.
  const appAccess = roles.includes('admin') ? null : access?.app_access ?? null;
  const limited = limitToApps(permissions, appAccess);

  // Sharing an app with someone whose role does nothing in it (an Employee
  // given Leads, say) gives them a Member's everyday access there. Otherwise
  // the app would be "shared" yet never appear for them.
  for (const slug of appAccess ?? []) {
    const working = [...limited].some((p) => p.startsWith(`${slug}.`) && p.split('.')[1] !== 'self');
    if (working) continue;
    for (const permission of memberLevel()) if (permission.startsWith(`${slug}.`)) limited.add(permission);
  }
  // A permission denied to this person directly stays denied.
  for (const row of direct) if (row.effect === 'deny') limited.delete(row.permission);

  return { roles, permissions: limited, isOwner: false, appAccess };
}

let memberPermissions = null;
const memberLevel = () => (memberPermissions ??= permissionsForRoleTemplate(SYSTEM_ROLES.find((r) => r.slug === 'member')));

/** Never limited by app access: the workspace itself, and billing. */
const WORKSPACE_APPS = new Set(['core', 'billing', 'catalog']);

/**
 * Drop permissions for apps this person was not given. Their own records
 * (`<app>.self.*`: payslips, leave, attendance) stay, because those are
 * about them rather than about the app.
 */
export function limitToApps(permissions, appAccess) {
  if (!appAccess) return permissions;
  const allowed = new Set(appAccess);
  return new Set([...permissions].filter((permission) => {
    const [appSlug, resource] = permission.split('.');
    return WORKSPACE_APPS.has(appSlug) || allowed.has(appSlug) || resource === 'self';
  }));
}

/** Any change to who-can-do-what bumps the epoch, invalidating live tokens. */
export async function bumpEpoch(tx, orgId) {
  const row = await tx.one(
    `UPDATE organizations SET epoch = epoch + 1 WHERE id = $1 RETURNING epoch`,
    [orgId],
  );
  return row?.epoch;
}
