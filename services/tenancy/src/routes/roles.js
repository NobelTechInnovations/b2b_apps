import { id } from '@nexus/db-kit';
import { requirePermission, body, validate as v, notFound, badRequest, forbidden } from '@nexus/service-kit';
import { APPS, allPermissions } from '@nexus/contracts';
import { EVENTS } from '@nexus/contracts/events';
import { bumpEpoch, expand, matches } from '../lib/permissions.js';

/** Explicit grants plus whatever the role's patterns cover today, minus denials. */
function effectivePermissions(role) {
  const out = new Set(role.explicit_permissions ?? []);
  for (const permission of expand(role.permission_patterns ?? [])) out.add(permission);
  for (const pattern of role.denied_patterns ?? []) {
    for (const permission of [...out]) {
      if (matches(pattern, permission)) out.delete(permission);
    }
  }
  return [...out].sort();
}

const VALID = new Set(allPermissions());

export async function roleRoutes(app) {
  const { db } = app;

  // The permission catalogue, grouped for the role editor UI.
  app.get('/permissions', { preHandler: app.loadContext }, async (request) => {
    const entitled = request.ctx.apps;

    const groups = APPS.filter((a) => a.core || entitled.has(a.slug)).map((a) => ({
      app: a.slug,
      name: a.name,
      icon: a.icon,
      color: a.color,
      resources: Object.entries(
        a.permissions.reduce((acc, permission) => {
          const [, resource, action] = permission.split('.');
          (acc[resource] ??= []).push({ permission, action });
          return acc;
        }, {}),
      ).map(([resource, actions]) => ({ resource, actions })),
    }));

    return { data: groups };
  });

  app.get(
    '/roles',
    { preHandler: [app.loadContext, requirePermission('core.roles.view')] },
    async (request) => {
      const roles = await db.rows(
        `SELECT r.*,
                COALESCE((SELECT array_agg(rp.permission) FROM role_permissions rp WHERE rp.role_id = r.id), '{}') AS explicit_permissions,
                (SELECT count(*)::int FROM member_roles mr WHERE mr.role_id = r.id) AS member_count
           FROM roles r WHERE r.org_id = $1
          ORDER BY r.is_system DESC, r.name`,
        [request.ctx.orgId],
      );

      return {
        data: roles.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description,
          is_system: r.is_system,
          is_protected: r.is_protected,
          implicit_all: r.implicit_all,
          member_count: r.member_count,
          // System roles are defined by patterns, so what they grant is
          // computed now rather than read from a stale snapshot.
          permissions: r.implicit_all ? ['*'] : effectivePermissions(r),
        })),
      };
    },
  );

  app.post(
    '/roles',
    {
      preHandler: [app.loadContext, requirePermission('core.roles.manage')],
      schema: {
        body: body(
          {
            name: v.text(60, 2),
            description: v.text(240),
            permissions: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 400 },
          },
          ['name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const permissions = dedupeValid(request.body.permissions ?? [], request.ctx);

      const slug = request.body.name
        .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
      if (!slug) throw badRequest('That role name cannot be turned into an identifier.');

      const exists = await db.one(`SELECT 1 FROM roles WHERE org_id = $1 AND slug = $2`, [orgId, slug]);
      if (exists) throw badRequest('A role with that name already exists.');

      const role = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO roles (id, org_id, slug, name, description) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [id('rol'), orgId, slug, request.body.name.trim(), request.body.description ?? null],
        );

        if (permissions.length) {
          const values = permissions.map((_, i) => `($1, $2, $${i + 3})`).join(', ');
          await tx.query(
            `INSERT INTO role_permissions (org_id, role_id, permission) VALUES ${values}`,
            [orgId, created.id, ...permissions],
          );
        }

        tx.emit({
          type: EVENTS.ROLE_UPDATED,
          org_id: orgId,
          actor_id: userId,
          data: { role_id: created.id, slug, action: 'created' },
        });

        return created;
      });

      return reply.status(201).send({ data: { ...role, permissions } });
    },
  );

  app.put(
    '/roles/:roleId',
    {
      preHandler: [app.loadContext, requirePermission('core.roles.manage')],
      schema: {
        params: { type: 'object', properties: { roleId: v.id('rol') }, required: ['roleId'] },
        body: body({
          name: v.text(60, 2),
          description: v.text(240),
          permissions: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 400 },
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const role = await db.one(`SELECT * FROM roles WHERE id = $1 AND org_id = $2`, [
        request.params.roleId,
        orgId,
      ]);
      if (!role) throw notFound('Role');
      if (role.implicit_all) throw forbidden('The owner role cannot be edited.');

      const permissions =
        request.body.permissions === undefined
          ? null
          : dedupeValid(request.body.permissions, request.ctx);

      const updated = await db.transaction(async (tx) => {
        const row = await tx.one(
          `UPDATE roles SET name = COALESCE($3, name), description = COALESCE($4, description)
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [role.id, orgId, request.body.name ?? null, request.body.description ?? null],
        );

        if (permissions) {
          await tx.query(`DELETE FROM role_permissions WHERE role_id = $1`, [role.id]);
          if (permissions.length) {
            const values = permissions.map((_, i) => `($1, $2, $${i + 3})`).join(', ');
            await tx.query(
              `INSERT INTO role_permissions (org_id, role_id, permission) VALUES ${values}`,
              [orgId, role.id, ...permissions],
            );
          }
          await bumpEpoch(tx, orgId);
        }

        tx.emit({
          type: EVENTS.ROLE_UPDATED,
          org_id: orgId,
          actor_id: userId,
          data: { role_id: role.id, slug: role.slug, action: 'updated' },
        });

        return row;
      });

      return { data: { ...updated, permissions: permissions ?? undefined } };
    },
  );

  app.delete(
    '/roles/:roleId',
    {
      preHandler: [app.loadContext, requirePermission('core.roles.manage')],
      schema: { params: { type: 'object', properties: { roleId: v.id('rol') }, required: ['roleId'] } },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const role = await db.one(`SELECT * FROM roles WHERE id = $1 AND org_id = $2`, [
        request.params.roleId,
        orgId,
      ]);
      if (!role) throw notFound('Role');
      if (role.is_protected) throw forbidden('Built-in roles cannot be deleted.');

      const inUse = await db.one(
        `SELECT count(*)::int AS n FROM member_roles WHERE role_id = $1`,
        [role.id],
      );
      if (inUse.n > 0) {
        throw badRequest(
          `${inUse.n} ${inUse.n === 1 ? 'person is' : 'people are'} assigned this role. Reassign them first.`,
        );
      }

      await db.transaction(async (tx) => {
        await tx.query(`DELETE FROM roles WHERE id = $1 AND org_id = $2`, [role.id, orgId]);
        await bumpEpoch(tx, orgId);
      });

      return { data: { deleted: true } };
    },
  );
}

/**
 * Only real permissions, only for apps this workspace actually has. You cannot
 * pre-grant HR permissions to a workspace that has not bought HR.
 */
function dedupeValid(permissions, ctx) {
  const out = new Set();
  for (const permission of permissions) {
    if (!VALID.has(permission)) continue;
    const appSlug = permission.split('.')[0];
    const isCoreish = ['core', 'billing', 'catalog'].includes(appSlug);
    if (!isCoreish && !ctx.apps.has(appSlug)) continue;
    out.add(permission);
  }
  return [...out];
}
