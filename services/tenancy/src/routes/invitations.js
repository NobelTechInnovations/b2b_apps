import { id } from '@nexus/db-kit';
import { createHash, randomBytes } from 'node:crypto';
import { requirePermission, body, validate as v, notFound, badRequest, conflict } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { assertSeatAvailable } from '../lib/seats.js';
import { workspaceUrl } from '../lib/addresses.js';

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

export async function invitationRoutes(app) {
  const { db, identity, config } = app;

  app.get(
    '/invitations',
    { preHandler: [app.loadContext, requirePermission('core.members.view')] },
    async (request) => {
      const rows = await db.rows(
        `SELECT i.id, i.email, i.title, i.status, i.expires_at, i.created_at, i.invited_by,
                COALESCE((SELECT json_agg(json_build_object('id', r.id, 'slug', r.slug, 'name', r.name))
                            FROM roles r WHERE r.id = ANY(i.role_ids)), '[]') AS roles
           FROM invitations i
          WHERE i.org_id = $1 AND i.status = 'pending' AND i.expires_at > now()
          ORDER BY i.created_at DESC`,
        [request.ctx.orgId],
      );
      return { data: rows };
    },
  );

  app.post(
    '/invitations',
    {
      preHandler: [app.loadContext, requirePermission('core.members.invite')],
      schema: {
        body: body(
          {
            email: v.email,
            role_ids: { type: 'array', items: v.id('rol'), minItems: 1, maxItems: 20 },
            title: v.text(80),
            message: v.text(500),
          },
          ['email', 'role_ids'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const email = request.body.email.trim().toLowerCase();

      const roles = await db.rows(`SELECT * FROM roles WHERE id = ANY($1) AND org_id = $2`, [
        request.body.role_ids,
        orgId,
      ]);
      if (roles.length !== request.body.role_ids.length) {
        throw badRequest('One or more roles do not exist in this workspace.');
      }
      if (roles.some((r) => r.slug === 'owner') && !request.ctx.isOwner) {
        throw badRequest('Only an owner can invite another owner.');
      }

      // Already a member? Say so plainly rather than sending a dead invitation.
      const existingUser = await identity.userByEmail(email);
      if (existingUser) {
        const member = await db.one(
          `SELECT id FROM members WHERE org_id = $1 AND user_id = $2 AND status <> 'removed'`,
          [orgId, existingUser.id],
        );
        if (member) throw conflict('That person is already a member of this workspace.');
      }

      await assertSeatAvailable({ db, config, orgId, email });

      const raw = randomBytes(32).toString('base64url');

      const invitation = await db.transaction(async (tx) => {
        // Re-inviting replaces the previous pending invitation rather than erroring.
        await tx.query(
          `UPDATE invitations SET status = 'revoked'
            WHERE org_id = $1 AND lower(email) = $2 AND status = 'pending'`,
          [orgId, email],
        );

        const created = await tx.one(
          `INSERT INTO invitations
             (id, org_id, email, token_hash, role_ids, title, message, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '14 days')
           RETURNING *`,
          [
            id('inv'), orgId, email, hashToken(raw), request.body.role_ids,
            request.body.title ?? null, request.body.message ?? null, userId,
          ],
        );

        const org = await tx.one(`SELECT name, slug FROM organizations WHERE id = $1`, [orgId]);

        tx.emit({
          type: EVENTS.MEMBER_INVITED,
          org_id: orgId,
          actor_id: userId,
          data: {
            invitation_id: created.id,
            email,
            org_name: org.name,
            invited_by: userId,
            inviter_name: request.ctx.email,
            message: request.body.message ?? null,
            roles: roles.map((r) => r.name),
            link: workspaceUrl(config, org?.slug, `/join?token=${raw}`),
            existing_user: Boolean(existingUser),
          },
        });

        return { ...created, org_slug: org?.slug };
      });

      return reply.status(201).send({
        data: {
          id: invitation.id,
          email: invitation.email,
          status: invitation.status,
          expires_at: invitation.expires_at,
          roles: roles.map((r) => ({ id: r.id, slug: r.slug, name: r.name })),
          // Returned once, for "copy invite link". Never stored in plaintext.
          invite_link: workspaceUrl(config, invitation.org_slug, `/join?token=${raw}`),
        },
      });
    },
  );

  app.delete(
    '/invitations/:invitationId',
    {
      preHandler: [app.loadContext, requirePermission('core.members.invite')],
      schema: { params: { type: 'object', properties: { invitationId: v.id('inv') }, required: ['invitationId'] } },
    },
    async (request) => {
      const row = await db.one(
        `UPDATE invitations SET status = 'revoked'
          WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING id`,
        [request.params.invitationId, request.ctx.orgId],
      );
      if (!row) throw notFound('Invitation');
      return { data: { revoked: true } };
    },
  );

  /** Public preview of an invitation, so the join page can show who invited you. */
  /**
   * What an invitation is for, before you have signed in.
   *
   * Reachable without a session — an invited person has no account yet, so
   * requiring one to read their own invitation would be a closed loop. It
   * returns only what the email already told them: the workspace, the role,
   * and the address it was sent to.
   */
  app.get(
    '/invite/:token',
    { schema: { params: { type: 'object', properties: { token: { type: 'string', maxLength: 200 } }, required: ['token'] } } },
    async (request) => {
      const invitation = await db.one(
        `SELECT i.email, i.title, i.expires_at, o.name AS org_name, o.logo_url, o.slug AS org_slug,
                COALESCE((SELECT json_agg(r.name) FROM roles r WHERE r.id = ANY(i.role_ids)), '[]') AS role_names
           FROM invitations i JOIN organizations o ON o.id = i.org_id
          WHERE i.token_hash = $1 AND i.status = 'pending' AND i.expires_at > now()`,
        [hashToken(request.params.token)],
      );
      if (!invitation) throw notFound('Invitation');

      const user = await identity.userByEmail(invitation.email);

      return {
        data: {
          email: invitation.email,
          organization: { name: invitation.org_name, slug: invitation.org_slug, logo_url: invitation.logo_url },
          roles: invitation.role_names,
          title: invitation.title,
          expires_at: invitation.expires_at,
          has_account: Boolean(user),
        },
      };
    },
  );

  /** Accept as an already-signed-in user. */
  app.post(
    '/invitations/accept',
    {
      preHandler: app.authenticate,
      schema: { body: body({ token: { type: 'string', maxLength: 200 } }, ['token']) },
    },
    async (request) => {
      const result = await acceptInvitation(db, {
        token: request.body.token,
        userId: request.auth.userId,
        email: request.auth.email,
      });
      return { data: result };
    },
  );
}

/**
 * Shared by the signed-in route and the internal route identity calls during
 * registration. Idempotent: accepting twice returns the same membership.
 */
export async function acceptInvitation(db, { token, userId, email }) {
  return db.transaction(async (tx) => {
    const invitation = await tx.one(
      `SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(token)],
    );
    if (!invitation) throw notFound('Invitation');

    if (invitation.status === 'accepted') {
      const existing = await tx.one(
        `SELECT id FROM members WHERE org_id = $1 AND user_id = $2 AND status <> 'removed'`,
        [invitation.org_id, userId],
      );
      if (existing) return { org_id: invitation.org_id, member_id: existing.id, already_accepted: true };
    }

    if (invitation.status !== 'pending') throw badRequest('That invitation is no longer valid.');
    if (new Date(invitation.expires_at) < new Date()) {
      await tx.query(`UPDATE invitations SET status = 'expired' WHERE id = $1`, [invitation.id]);
      throw badRequest('That invitation has expired. Ask for a new one.');
    }
    if (email && email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw badRequest('This invitation was sent to a different email address.');
    }

    let member = await tx.one(
      `SELECT * FROM members WHERE org_id = $1 AND user_id = $2`,
      [invitation.org_id, userId],
    );

    if (member) {
      member = await tx.one(
        `UPDATE members SET status = 'active', title = COALESCE($3, title) WHERE id = $1 AND org_id = $2 RETURNING *`,
        [member.id, invitation.org_id, invitation.title],
      );
    } else {
      member = await tx.one(
        `INSERT INTO members (id, org_id, user_id, status, title) VALUES ($1, $2, $3, 'active', $4) RETURNING *`,
        [id('mem'), invitation.org_id, userId, invitation.title],
      );
    }

    if (invitation.role_ids.length) {
      const values = invitation.role_ids.map((_, i) => `($1, $2, $${i + 3}, $${invitation.role_ids.length + 3})`).join(', ');
      await tx.query(
        `INSERT INTO member_roles (org_id, member_id, role_id, granted_by) VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [invitation.org_id, member.id, ...invitation.role_ids, invitation.invited_by],
      );
    }

    await tx.query(
      `UPDATE invitations SET status = 'accepted', accepted_at = now(), accepted_by = $2 WHERE id = $1`,
      [invitation.id, userId],
    );

    await tx.query(`UPDATE organizations SET epoch = epoch + 1 WHERE id = $1`, [invitation.org_id]);

    tx.emit({
      type: EVENTS.MEMBER_JOINED,
      org_id: invitation.org_id,
      actor_id: userId,
      data: { member_id: member.id, user_id: userId, email: invitation.email, via: 'invitation' },
    });

    return { org_id: invitation.org_id, member_id: member.id, already_accepted: false };
  });
}
