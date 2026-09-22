import { createHash } from 'node:crypto';
import { requireInternal, notFound } from '@nexus/service-kit';
import { resolveMemberPermissions } from '../lib/permissions.js';
import { acceptInvitation } from './invitations.js';

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

/**
 * Internal surface. Identity uses it to mint org-scoped tokens; the gateway
 * uses it to resolve the permission set for a request. Never public.
 */
export async function internalRoutes(app) {
  const { db } = app;

  app.get('/internal/users/:userId/memberships', { preHandler: requireInternal() }, async (request) => {
    const rows = await db.rows(
      `SELECT m.id, m.org_id, m.status, m.title,
              o.name AS org_name, o.slug AS org_slug, o.logo_url AS org_logo_url,
              o.currency, o.timezone, o.epoch,
              COALESCE((SELECT array_agg(r.slug) FROM member_roles mr
                          JOIN roles r ON r.id = mr.role_id
                         WHERE mr.member_id = m.id), '{}') AS roles
         FROM members m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
        ORDER BY m.joined_at`,
      [request.params.userId],
    );
    return { data: rows };
  });

  app.get('/internal/users/:userId/memberships/:orgId', { preHandler: requireInternal() }, async (request) => {
    const row = await db.one(
      `SELECT m.id, m.org_id, m.status, m.title,
              o.name AS org_name, o.slug AS org_slug, o.logo_url AS org_logo_url,
              o.currency, o.timezone, o.epoch,
              COALESCE((SELECT array_agg(r.slug) FROM member_roles mr
                          JOIN roles r ON r.id = mr.role_id
                         WHERE mr.member_id = m.id), '{}') AS roles
         FROM members m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active' AND o.status = 'active'`,
      [request.params.userId, request.params.orgId],
    );
    if (!row) throw notFound('Membership');
    return { data: row };
  });

  /** The gateway's authorization lookup, called once per cache miss. */
  app.get('/internal/authz/:orgId/:userId', { preHandler: requireInternal() }, async (request) => {
    const { orgId, userId } = request.params;

    const member = await db.one(
      `SELECT m.id, m.status, o.epoch, o.status AS org_status
         FROM members m JOIN organizations o ON o.id = m.org_id
        WHERE m.org_id = $1 AND m.user_id = $2`,
      [orgId, userId],
    );

    if (!member || member.status !== 'active' || member.org_status !== 'active') {
      return { data: { allowed: false, reason: !member ? 'not_a_member' : 'inactive' } };
    }

    const resolved = await resolveMemberPermissions(db, { orgId, memberId: member.id });

    return {
      data: {
        allowed: true,
        member_id: member.id,
        epoch: member.epoch,
        roles: resolved.roles,
        is_owner: resolved.isOwner,
        permissions: [...resolved.permissions],
      },
    };
  });

  app.get('/internal/invitations/:token', { preHandler: requireInternal() }, async (request) => {
    const invitation = await db.one(
      `SELECT id, org_id, email, status, expires_at FROM invitations
        WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()`,
      [hashToken(request.params.token)],
    );
    if (!invitation) throw notFound('Invitation');
    return { data: invitation };
  });

  app.post('/internal/invitations/accept', { preHandler: requireInternal() }, async (request) => {
    const result = await acceptInvitation(db, {
      token: request.body.token,
      userId: request.body.user_id,
    });
    return { data: result };
  });

  /** Billing and catalog ask for the seat count when pricing per user. */
  app.get('/internal/orgs/:orgId/stats', { preHandler: requireInternal() }, async (request) => {
    const stats = await db.one(
      `SELECT
         (SELECT count(*)::int FROM members WHERE org_id = $1 AND status = 'active') AS active_members,
         (SELECT count(*)::int FROM invitations WHERE org_id = $1 AND status = 'pending') AS pending_invitations,
         o.name, o.slug, o.currency, o.owner_user_id, o.created_at
       FROM organizations o WHERE o.id = $1`,
      [request.params.orgId],
    );
    if (!stats) throw notFound('Organization');
    return { data: stats };
  });
}
