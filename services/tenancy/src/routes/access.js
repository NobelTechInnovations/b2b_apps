import { id } from '@nexus/db-kit';
import { requirePermission, body, params, query, validate as v, notFound, badRequest, forbidden } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { APPS, allPermissions, appBySlug, permissionLabel } from '@nexus/contracts';
import { bumpEpoch, resolveMemberPermissions } from '../lib/permissions.js';

const KNOWN = new Set(allPermissions());
const APP_SLUGS = new Set(APPS.filter((a) => !a.core).map((a) => a.slug));
const memberParams = { params: params({ memberId: v.id('mem') }) };

/**
 * One person, one extra ability — and asking for one.
 *
 * Roles give a group of people the same abilities. Sometimes one person needs
 * one more ("Lead sources" for the senior caller) without a new role, or one
 * fewer. Those are kept per person. People can also ask: for an app they
 * cannot open, or for an ability inside one they use; an owner or admin
 * approves (which grants it to that person) or declines.
 */
export async function accessRoutes(app) {
  const { db, identity } = app;

  // ════════════════════════════════════════════════ ONE PERSON'S ABILITIES
  app.get('/members/:memberId/permissions', { preHandler: [app.loadContext, requirePermission('core.roles.manage')], schema: memberParams }, async (request) => {
    const { orgId } = request.ctx;
    const member = await db.one(`SELECT id, app_access FROM members WHERE org_id = $1 AND id = $2 AND status <> 'removed'`, [orgId, request.params.memberId]);
    if (!member) throw notFound('Member');
    const [resolved, extra] = await Promise.all([
      resolveMemberPermissions(db, { orgId, memberId: member.id }),
      db.rows(`SELECT permission, effect FROM member_permissions WHERE org_id = $1 AND member_id = $2 ORDER BY permission`, [orgId, member.id]),
    ]);
    return {
      data: {
        is_owner: resolved.isOwner,
        roles: resolved.roles,
        app_access: resolved.appAccess,
        effective: [...resolved.permissions].sort(),
        extra: extra.map((row) => ({ ...row, label: permissionLabel(row.permission) })),
      },
    };
  });

  /**
   * Replace this person's extras: `allow` adds abilities beyond their role,
   * `deny` takes some away. Nobody can hand out an ability they lack.
   */
  app.put('/members/:memberId/permissions', {
    preHandler: [app.loadContext, requirePermission('core.roles.manage')],
    schema: {
      ...memberParams,
      body: body({
        allow: { type: 'array', items: v.text(80), maxItems: 200 },
        deny: { type: 'array', items: v.text(80), maxItems: 200 },
      }),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const allow = [...new Set(request.body.allow ?? [])];
    const deny = [...new Set(request.body.deny ?? [])].filter((p) => !allow.includes(p));
    const unknown = [...allow, ...deny].filter((p) => !KNOWN.has(p));
    if (unknown.length) throw badRequest(`Unknown ability: ${unknown.join(', ')}.`);
    const beyondYou = allow.filter((p) => !request.ctx.can(p));
    if (beyondYou.length) throw forbidden(`You cannot give abilities you do not have: ${beyondYou.map(permissionLabel).join(', ')}.`);

    await db.transaction(async (tx) => {
      const member = await tx.one(`SELECT id, user_id FROM members WHERE org_id = $1 AND id = $2 AND status <> 'removed' FOR UPDATE`, [orgId, request.params.memberId]);
      if (!member) throw notFound('Member');
      await tx.query(`DELETE FROM member_permissions WHERE org_id = $1 AND member_id = $2`, [orgId, member.id]);
      for (const [permission, effect] of [...allow.map((p) => [p, 'allow']), ...deny.map((p) => [p, 'deny'])]) {
        await tx.query(`INSERT INTO member_permissions (org_id, member_id, permission, effect) VALUES ($1,$2,$3,$4)`, [orgId, member.id, permission, effect]);
      }
      await bumpEpoch(tx, orgId);
      tx.emit({ type: EVENTS.MEMBER_ROLE_CHANGED, org_id: orgId, actor_id: userId, data: { member_id: member.id, user_id: member.user_id, extra: { allow, deny } } });
    });
    return { data: { allow, deny } };
  });

  // ═══════════════════════════════════════════════════════ ASKING FOR ACCESS
  const shapeRequest = (row, names) => ({
    ...row,
    app_name: row.app_slug ? appBySlug(row.app_slug)?.name ?? row.app_slug : null,
    permission_label: row.permission ? permissionLabel(row.permission) : null,
    person: names?.get(row.user_id) ?? null,
  });

  /** Anyone signed in to the workspace may ask; asking twice for the same thing does not pile up. */
  app.post('/members/me/access-requests', {
    preHandler: [app.loadContext],
    schema: { body: body({ app_slug: v.text(40), permission: v.text(80), note: v.text(1000, 0) }) },
  }, async (request, reply) => {
    const { orgId, userId, memberId } = request.ctx;
    const b = request.body ?? {};
    const appSlug = b.app_slug ?? (b.permission ? b.permission.split('.')[0] : null);
    if (appSlug && !APP_SLUGS.has(appSlug)) throw badRequest('That app does not exist.');
    if (b.permission && !KNOWN.has(b.permission)) throw badRequest('That ability does not exist.');
    if (!appSlug && !b.permission && !b.note?.trim()) throw badRequest('Say what you need access to.');
    if (b.permission && request.ctx.can(b.permission)) throw badRequest('You can already do that.');

    const row = await db.transaction(async (tx) => {
      const twin = await tx.one(
        `SELECT * FROM access_requests WHERE org_id = $1 AND member_id = $2 AND status = 'pending'
            AND app_slug IS NOT DISTINCT FROM $3 AND permission IS NOT DISTINCT FROM $4`,
        [orgId, memberId, appSlug, b.permission ?? null],
      );
      if (twin) return twin;
      const created = await tx.one(
        `INSERT INTO access_requests (id, org_id, member_id, user_id, app_slug, permission, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id('acr'), orgId, memberId, userId, appSlug, b.permission ?? null, b.note?.trim() || null],
      );
      const names = await identity.users({ ids: [userId] });
      tx.emit({
        type: EVENTS.ACCESS_REQUESTED, org_id: orgId, actor_id: userId,
        data: {
          request_id: created.id, user_id: userId, name: names.get(userId)?.name ?? request.ctx.email,
          app_name: appSlug ? appBySlug(appSlug)?.name ?? appSlug : null,
          ability: b.permission ? permissionLabel(b.permission) : null, note: created.note,
        },
      });
      return created;
    });
    return reply.status(201).send({ data: shapeRequest(row) });
  });

  app.get('/members/me/access-requests', { preHandler: [app.loadContext] }, async (request) => {
    const rows = await db.rows(
      `SELECT * FROM access_requests WHERE org_id = $1 AND member_id = $2 ORDER BY created_at DESC LIMIT 20`,
      [request.ctx.orgId, request.ctx.memberId],
    );
    return { data: rows.map((row) => shapeRequest(row)) };
  });

  app.get('/members/access-requests', {
    preHandler: [app.loadContext, requirePermission('core.roles.manage')],
    schema: { querystring: query({ status: v.enum(['pending', 'approved', 'declined']) }) },
  }, async (request) => {
    const rows = await db.rows(
      `SELECT * FROM access_requests WHERE org_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 100`,
      [request.ctx.orgId, request.query.status ?? 'pending'],
    );
    const names = await identity.users({ ids: [...new Set(rows.map((r) => r.user_id))] });
    return { data: rows.map((row) => shapeRequest(row, names)) };
  });

  /** Approving shares the app (and grants the ability) with that one person. */
  app.post('/members/access-requests/:requestId/decide', {
    preHandler: [app.loadContext, requirePermission('core.roles.manage')],
    schema: {
      params: params({ requestId: v.id('acr') }),
      body: body({ decision: v.enum(['approve', 'decline']), note: v.text(500, 0) }, ['decision']),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const ask = await tx.one(`SELECT * FROM access_requests WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, request.params.requestId]);
      if (!ask) throw notFound('Request');
      if (ask.status !== 'pending') throw badRequest(`This request was already ${ask.status}.`);
      const approve = request.body.decision === 'approve';
      if (approve) {
        if (ask.permission && !request.ctx.can(ask.permission)) throw forbidden('You cannot give an ability you do not have.');
        const member = await tx.one(`SELECT id, user_id, app_access FROM members WHERE org_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`, [orgId, ask.member_id]);
        if (!member) throw badRequest('That person is no longer in the workspace.');
        if (ask.app_slug && member.app_access && !member.app_access.includes(ask.app_slug)) {
          await tx.query(`UPDATE members SET app_access = $3 WHERE org_id = $1 AND id = $2`, [orgId, member.id, [...member.app_access, ask.app_slug].sort()]);
        }
        if (ask.permission) {
          await tx.query(
            `INSERT INTO member_permissions (org_id, member_id, permission, effect) VALUES ($1,$2,$3,'allow')
             ON CONFLICT (member_id, permission) DO UPDATE SET effect = 'allow'`,
            [orgId, member.id, ask.permission],
          );
        }
        await bumpEpoch(tx, orgId);
        tx.emit({ type: EVENTS.MEMBER_ROLE_CHANGED, org_id: orgId, actor_id: userId, data: { member_id: member.id, user_id: member.user_id, via: 'access_request' } });
      }
      const decided = await tx.one(
        `UPDATE access_requests SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
          WHERE org_id = $1 AND id = $2 RETURNING *`,
        [orgId, ask.id, approve ? 'approved' : 'declined', userId, request.body.note?.trim() || null],
      );
      tx.emit({
        type: EVENTS.ACCESS_DECIDED, org_id: orgId, actor_id: userId,
        data: {
          request_id: ask.id, user_id: ask.user_id, approved: approve, note: decided.decision_note,
          app_name: ask.app_slug ? appBySlug(ask.app_slug)?.name ?? ask.app_slug : null,
          ability: ask.permission ? permissionLabel(ask.permission) : null,
        },
      });
      return decided;
    });
    return { data: shapeRequest(row) };
  });
}
