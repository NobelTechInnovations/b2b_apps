import { createHash, randomBytes } from 'node:crypto';
import { id } from '@nexus/db-kit';
import { requireInternal, notFound, badRequest, conflict } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
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
         o.name, o.slug, o.currency, o.owner_user_id, o.created_at,
         -- Invoicing needs these: the GSTIN's first two digits decide
         -- CGST/SGST versus IGST, and the fiscal year drives numbering.
         o.tax_id, o.fiscal_year_start, o.timezone, o.country, o.address
       FROM organizations o WHERE o.id = $1`,
      [request.params.orgId],
    );
    if (!stats) throw notFound('Organization');
    return { data: stats };
  });

  /**
   * The workspace's roles, so another service can find the one it needs by
   * slug. HR uses this to attach the `employee` role to a portal invitation.
   */
  app.get('/internal/orgs/:orgId/roles', { preHandler: requireInternal() }, async (request) => {
    const rows = await db.rows(
      `SELECT id, slug, name, description, is_system, is_protected
         FROM roles WHERE org_id = $1 ORDER BY slug`,
      [request.params.orgId],
    );
    return { data: rows };
  });

  /**
   * Invite somebody, on behalf of a service rather than a signed-in user.
   *
   * HR uses this for portal invitations. It is deliberately the SAME flow an
   * admin uses from the members screen — same table, same token, same
   * acceptance path — because a second invitation mechanism is a second thing
   * to keep secure.
   */
  app.post('/internal/invitations', { preHandler: requireInternal() }, async (request) => {
    const { org_id: orgId, email: rawEmail, role_ids: roleIds, title, message, invited_by: invitedBy } =
      request.body ?? {};

    if (!orgId || !rawEmail || !roleIds?.length) {
      throw badRequest('org_id, email and role_ids are required.');
    }

    const email = String(rawEmail).trim().toLowerCase();

    const roles = await db.rows(
      `SELECT id, slug, name FROM roles WHERE id = ANY($1) AND org_id = $2`,
      [roleIds, orgId],
    );
    if (roles.length !== roleIds.length) {
      throw badRequest('One or more roles do not exist in this workspace.');
    }
    // A service may never hand out ownership of a workspace, whatever it asks.
    if (roles.some((r) => r.slug === 'owner')) {
      throw badRequest('An owner invitation cannot be sent by a service.');
    }

    const existingUser = await app.identity.userByEmail(email).catch(() => null);
    if (existingUser) {
      const member = await db.one(
        `SELECT id FROM members WHERE org_id = $1 AND user_id = $2 AND status <> 'removed'`,
        [orgId, existingUser.id],
      );
      if (member) throw conflict('That person is already a member of this workspace.');
    }

    const raw = randomBytes(32).toString('base64url');

    const invitation = await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE invitations SET status = 'revoked'
          WHERE org_id = $1 AND lower(email) = $2 AND status = 'pending'`,
        [orgId, email],
      );

      const created = await tx.one(
        `INSERT INTO invitations
           (id, org_id, email, token_hash, role_ids, title, message, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + interval '14 days')
         RETURNING *`,
        [
          id('inv'), orgId, email, hashToken(raw), roleIds,
          title ?? null, message ?? null, invitedBy ?? 'service',
        ],
      );

      const org = await tx.one(`SELECT name FROM organizations WHERE id = $1`, [orgId]);

      tx.emit({
        type: EVENTS.MEMBER_INVITED,
        org_id: orgId,
        actor_id: invitedBy ?? null,
        data: {
          invitation_id: created.id,
          email,
          org_name: org?.name,
          roles: roles.map((r) => r.name),
          link: `${app.config.appUrl}/join?token=${raw}`,
          existing_user: Boolean(existingUser),
        },
      });

      return created;
    });

    return {
      data: {
        id: invitation.id,
        email: invitation.email,
        status: invitation.status,
        expires_at: invitation.expires_at,
        roles: roles.map((r) => ({ id: r.id, slug: r.slug, name: r.name })),
        invite_link: `${app.config.appUrl}/join?token=${raw}`,
      },
    };
  });

  app.post('/internal/invitations/:invitationId/revoke', { preHandler: requireInternal() }, async (request) => {
    const row = await db.one(
      `UPDATE invitations SET status = 'revoked'
        WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING id`,
      [request.params.invitationId, request.body?.org_id],
    );
    if (!row) throw notFound('A pending invitation');
    return { data: { revoked: true } };
  });
}
