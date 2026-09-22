import { paginate } from '@nexus/db-kit';
import { requirePermission, body, query, validate as v, notFound, forbidden, badRequest } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { bumpEpoch, resolveMemberPermissions } from '../lib/permissions.js';

export async function memberRoutes(app) {
  const { db, identity } = app;

  /** The owner must never be left standing alone — or not at all. */
  async function assertNotLastOwner(tx, orgId, memberId) {
    const owners = await tx.rows(
      `SELECT mr.member_id FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         JOIN members m ON m.id = mr.member_id
        WHERE mr.org_id = $1 AND r.slug = 'owner' AND m.status = 'active'`,
      [orgId],
    );
    if (owners.length <= 1 && owners.some((o) => o.member_id === memberId)) {
      throw badRequest('This workspace must always have at least one owner.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/members',
    {
      preHandler: [app.loadContext, requirePermission('core.members.view')],
      schema: {
        querystring: query({
          status: v.enum(['active', 'invited', 'suspended']),
          role: v.text(40),
          team_id: v.id('tem'),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const { status, role, team_id: teamId, q } = request.query;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'joined_at', 'title'] });

      const filters = ['m.org_id = $1', "m.status <> 'removed'"];
      const values = [orgId];

      if (status) {
        values.push(status);
        filters.push(`m.status = $${values.length}`);
      }
      if (role) {
        values.push(role);
        filters.push(
          `EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                    WHERE mr.member_id = m.id AND r.slug = $${values.length})`,
        );
      }
      if (teamId) {
        values.push(teamId);
        filters.push(
          `EXISTS (SELECT 1 FROM team_members tm WHERE tm.member_id = m.id AND tm.team_id = $${values.length})`,
        );
      }

      const where = filters.join(' AND ');

      const rows = await db.rows(
        `SELECT m.*,
                COALESCE(
                  (SELECT json_agg(json_build_object('id', r.id, 'slug', r.slug, 'name', r.name))
                     FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                    WHERE mr.member_id = m.id), '[]'
                ) AS roles
           FROM members m
          WHERE ${where}
          ORDER BY m.${page.orderBy.startsWith('created_at') ? 'created_at DESC' : page.orderBy}
          LIMIT ${page.limit} OFFSET ${page.offset}`,
        values,
      );

      const total = await db.one(`SELECT count(*)::int AS n FROM members m WHERE ${where}`, values);

      // Names and emails live in identity, so hydrate here rather than duplicating them.
      const profiles = await identity.users({ ids: rows.map((r) => r.user_id) });

      let data = rows.map((m) => shape(m, profiles.get(m.user_id)));

      if (q) {
        const needle = q.toLowerCase();
        data = data.filter(
          (m) =>
            m.name?.toLowerCase().includes(needle) ||
            m.email?.toLowerCase().includes(needle) ||
            m.title?.toLowerCase().includes(needle),
        );
      }

      return { data, meta: page.meta(total.n) };
    },
  );

  // ══════════════════════════════════════════════════════════════════ READ
  app.get(
    '/members/:memberId',
    {
      preHandler: [app.loadContext, requirePermission('core.members.view')],
      schema: { params: { type: 'object', properties: { memberId: v.id('mem') }, required: ['memberId'] } },
    },
    async (request) => {
      const member = await db.one(
        `SELECT m.*,
                COALESCE((SELECT json_agg(json_build_object('id', r.id, 'slug', r.slug, 'name', r.name))
                            FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                           WHERE mr.member_id = m.id), '[]') AS roles
           FROM members m WHERE m.id = $1 AND m.org_id = $2`,
        [request.params.memberId, request.ctx.orgId],
      );
      if (!member) throw notFound('Member');

      const profiles = await identity.users({ ids: [member.user_id] });
      const resolved = await resolveMemberPermissions(db, {
        orgId: request.ctx.orgId,
        memberId: member.id,
      });

      return {
        data: {
          ...shape(member, profiles.get(member.user_id)),
          permissions: [...resolved.permissions].sort(),
        },
      };
    },
  );

  // ════════════════════════════════════════════════════════════ UPDATE ROLES
  app.put(
    '/members/:memberId/roles',
    {
      preHandler: [app.loadContext, requirePermission('core.roles.manage')],
      schema: {
        params: { type: 'object', properties: { memberId: v.id('mem') }, required: ['memberId'] },
        body: body({ role_ids: { type: 'array', items: v.id('rol'), maxItems: 20 } }, ['role_ids']),
      },
    },
    async (request) => {
      const { orgId, userId, isOwner } = request.ctx;
      const { memberId } = request.params;
      const { role_ids: roleIds } = request.body;

      const member = await db.one(`SELECT * FROM members WHERE id = $1 AND org_id = $2`, [memberId, orgId]);
      if (!member) throw notFound('Member');

      const roles = await db.rows(`SELECT * FROM roles WHERE id = ANY($1) AND org_id = $2`, [roleIds, orgId]);
      if (roles.length !== roleIds.length) throw badRequest('One or more roles do not exist in this workspace.');

      // Only an owner can hand out ownership.
      if (roles.some((r) => r.slug === 'owner') && !isOwner) {
        throw forbidden('Only an owner can grant the owner role.');
      }

      await db.transaction(async (tx) => {
        if (!roles.some((r) => r.slug === 'owner')) {
          await assertNotLastOwner(tx, orgId, memberId);
        }

        await tx.query(`DELETE FROM member_roles WHERE member_id = $1 AND org_id = $2`, [memberId, orgId]);

        if (roleIds.length) {
          const values = roleIds.map((_, i) => `($1, $2, $${i + 3}, $${roleIds.length + 3})`).join(', ');
          await tx.query(
            `INSERT INTO member_roles (org_id, member_id, role_id, granted_by) VALUES ${values}`,
            [orgId, memberId, ...roleIds, userId],
          );
        }

        await bumpEpoch(tx, orgId);

        tx.emit({
          type: EVENTS.MEMBER_ROLE_CHANGED,
          org_id: orgId,
          actor_id: userId,
          data: { member_id: memberId, user_id: member.user_id, roles: roles.map((r) => r.slug) },
        });
      });

      return { data: { updated: true, roles: roles.map((r) => ({ id: r.id, slug: r.slug, name: r.name })) } };
    },
  );

  // ══════════════════════════════════════════════════════════════════ EDIT
  app.patch(
    '/members/:memberId',
    {
      preHandler: [app.loadContext, requirePermission('core.members.edit')],
      schema: {
        params: { type: 'object', properties: { memberId: v.id('mem') }, required: ['memberId'] },
        body: body({ title: v.text(80), status: v.enum(['active', 'suspended']) }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const member = await db.one(`SELECT * FROM members WHERE id = $1 AND org_id = $2`, [
        request.params.memberId,
        orgId,
      ]);
      if (!member) throw notFound('Member');

      const updated = await db.transaction(async (tx) => {
        if (request.body.status === 'suspended') {
          await assertNotLastOwner(tx, orgId, member.id);
        }

        const row = await tx.one(
          `UPDATE members SET title = COALESCE($3, title), status = COALESCE($4, status)
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [member.id, orgId, request.body.title ?? null, request.body.status ?? null],
        );

        if (request.body.status === 'suspended') await bumpEpoch(tx, orgId);
        return row;
      });

      if (request.body.status === 'suspended') {
        await identity.revokeSessions(member.user_id, orgId, 'member_suspended');
      }

      const profiles = await identity.users({ ids: [updated.user_id] });
      return { data: shape(updated, profiles.get(updated.user_id)) };
    },
  );

  // ════════════════════════════════════════════════════════════════ REMOVE
  app.delete(
    '/members/:memberId',
    {
      preHandler: [app.loadContext, requirePermission('core.members.delete')],
      schema: { params: { type: 'object', properties: { memberId: v.id('mem') }, required: ['memberId'] } },
    },
    async (request) => {
      const { orgId, userId, memberId: actingMemberId } = request.ctx;
      const { memberId } = request.params;

      if (memberId === actingMemberId) {
        throw badRequest('You cannot remove yourself. Transfer ownership or ask another admin.');
      }

      const member = await db.one(`SELECT * FROM members WHERE id = $1 AND org_id = $2`, [memberId, orgId]);
      if (!member) throw notFound('Member');

      await db.transaction(async (tx) => {
        await assertNotLastOwner(tx, orgId, memberId);
        await tx.query(
          `UPDATE members SET status = 'removed' WHERE id = $1 AND org_id = $2`,
          [memberId, orgId],
        );
        await tx.query(`DELETE FROM member_roles WHERE member_id = $1`, [memberId]);
        await tx.query(`DELETE FROM team_members WHERE member_id = $1`, [memberId]);
        await bumpEpoch(tx, orgId);

        tx.emit({
          type: EVENTS.MEMBER_REMOVED,
          org_id: orgId,
          actor_id: userId,
          data: { member_id: memberId, user_id: member.user_id },
        });
      });

      // Their live sessions for this workspace end now, not in ten minutes.
      await identity.revokeSessions(member.user_id, orgId, 'member_removed');

      return { data: { removed: true } };
    },
  );
}

function shape(member, profile) {
  return {
    id: member.id,
    user_id: member.user_id,
    name: profile?.name ?? null,
    email: profile?.email ?? null,
    avatar_url: profile?.avatar_url ?? null,
    email_verified: Boolean(profile?.email_verified_at),
    title: member.title,
    status: member.status,
    roles: member.roles ?? [],
    joined_at: member.joined_at,
    last_seen_at: member.last_seen_at,
    created_at: member.created_at,
  };
}
