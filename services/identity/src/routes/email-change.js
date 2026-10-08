import { id } from '@nexus/db-kit';
import { body, validate as v, badRequest, conflict, forbidden, notFound } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { generateToken, hashToken, verifyPassword } from '../lib/password.js';
import { revokeAllSessions } from '../lib/sessions.js';

const normalize = (email) => email.trim().toLowerCase();
const invalidLink = () => badRequest('That email-change link is invalid or expired. Request a new one.');

function notify(tx, template, to, payload) {
  tx.emit({ type: EVENTS.NOTIFICATION_REQUESTED, data: { channel: 'email', template, to, payload } });
}

export async function emailChangeRoutes(app) {
  const { db, tenancy, config } = app;

  async function authorize(actorId, userId, orgId) {
    if (actorId !== userId) {
      if (!orgId) throw forbidden('Select a workspace before changing a member\'s email.');
      await tenancy.authorizeEmailChange({ actorId, userId, orgId });
    }
  }

  app.get('/auth/email-change', {
    preHandler: app.authenticate,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { user_id: v.id('usr') } } },
  }, async (request) => {
    const userId = request.query.user_id ?? request.auth.userId;
    await authorize(request.auth.userId, userId, request.auth.orgId);
    return { data: await db.one(
      `SELECT new_email, expires_at FROM email_change_requests
       WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`, [userId],
    ) };
  });

  app.post('/auth/change-email', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes', keyGenerator: (req) => req.auth?.userId ?? req.ip } },
    schema: { body: body({ email: v.email, current_password: v.text(200, 1), user_id: v.id('usr') }, ['email', 'current_password']) },
  }, async (request) => {
    const actorId = request.auth.userId;
    const userId = request.body.user_id ?? actorId;
    const email = normalize(request.body.email);
    await authorize(actorId, userId, request.auth.orgId);
    const actor = await db.one(`SELECT * FROM users WHERE id = $1 AND status = 'active'`, [actorId]);
    if (!actor || !(await verifyPassword(request.body.current_password, actor.password_hash))) {
      throw badRequest('Your current password is not correct.');
    }
    const token = generateToken();
    const result = await db.transaction(async (tx) => {
      const user = await tx.one(`SELECT * FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId]);
      if (!user) throw notFound('User');
      if (email === user.email_normalized) throw badRequest('Enter a different email address.');
      if (await tx.one(`SELECT id FROM users WHERE email_normalized = $1 AND status <> 'deleted'`, [email])) {
        throw conflict('That email address is already used by an account.');
      }
      await tx.query(`UPDATE email_change_requests SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);
      const change = await tx.one(
        `INSERT INTO email_change_requests (id, user_id, actor_id, org_id, old_email, new_email, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '24 hours') RETURNING new_email, expires_at`,
        [id('emc'), userId, actorId, request.auth.orgId, user.email_normalized, email, token.hash],
      );
      notify(tx, 'change_email', email, {
        name: user.name, link: `${config.appUrl}/confirm-email-change?token=${token.raw}`,
      });
      notify(tx, 'email_change_requested', user.email, { new_email: email, by_admin: actorId !== userId });
      return change;
    });
    return { data: result };
  });

  app.post('/auth/cancel-email-change', {
    preHandler: app.authenticate,
    schema: { body: body({ user_id: v.id('usr') }) },
  }, async (request) => {
    const userId = request.body.user_id ?? request.auth.userId;
    await authorize(request.auth.userId, userId, request.auth.orgId);
    await db.transaction(async (tx) => {
      await tx.one(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      await tx.query(`UPDATE email_change_requests SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);
    });
    return { data: { canceled: true } };
  });

  app.post('/auth/confirm-email-change', {
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    schema: { body: body({ token: v.text(200, 1) }, ['token']) },
  }, async (request) => {
    const hash = hashToken(request.body.token);
    const pending = await db.one(`SELECT * FROM email_change_requests WHERE token_hash = $1`, [hash]);
    if (!pending || pending.consumed_at || new Date(pending.expires_at) <= new Date()) throw invalidLink();
    // Recheck live admin authority at confirmation, not just when the email was sent.
    await authorize(pending.actor_id, pending.user_id, pending.org_id);
    const result = await db.transaction(async (tx) => {
      // Always lock user before request: requests, cancellation and confirmation serialize together.
      const user = await tx.one(`SELECT * FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [pending.user_id]);
      const change = await tx.one(
        `SELECT * FROM email_change_requests WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`, [hash],
      );
      if (!user || !change || user.email_normalized !== change.old_email) throw invalidLink();
      if (await tx.one(`SELECT id FROM users WHERE email_normalized = $1 AND status <> 'deleted'`, [change.new_email])) {
        throw conflict('That email address is already used by an account. Request a different address.');
      }
      await tx.query(`UPDATE users SET email = $2, email_normalized = $2, email_verified_at = now() WHERE id = $1`, [user.id, change.new_email]);
      await tx.query(`UPDATE email_change_requests SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [user.id]);
      await tx.query(`UPDATE email_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [user.id]);
      await revokeAllSessions(tx, user.id, { reason: 'email_changed' });
      tx.emit({
        type: EVENTS.USER_EMAIL_CHANGED, actor_id: change.actor_id, org_id: change.org_id,
        data: { user_id: user.id, old_email: change.old_email, email: change.new_email },
      });
      notify(tx, 'email_changed', change.old_email, { new_email: change.new_email });
      return { changed: true };
    });
    return { data: result };
  });
}
