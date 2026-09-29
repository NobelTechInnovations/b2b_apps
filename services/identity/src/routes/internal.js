import { requireInternal, notFound, badRequest } from '@nexus/service-kit';
import { announceRevoked } from '../lib/sessions.js';

/**
 * Service-to-service surface. Never reachable from the internet — the gateway
 * does not proxy /internal/*, and every route demands the service token.
 */
export async function internalRoutes(app) {
  const { db } = app;

  app.get('/internal/sessions/:sessionId', { preHandler: requireInternal() }, async (request) => {
    const row = await db.one(
      `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
         AND s.expires_at > now() AND u.status = 'active'`,
      [request.params.sessionId, request.query.user_id ?? null]);
    return { data: { active: Boolean(row) } };
  });

  /** Tenancy asks for user details when listing members. */
  app.post(
    '/internal/users/lookup',
    { preHandler: requireInternal() },
    async (request) => {
      const ids = request.body?.ids ?? [];
      const emails = (request.body?.emails ?? []).map((e) => e.toLowerCase());
      if (!ids.length && !emails.length) return { data: [] };

      const users = await db.rows(
        `SELECT id, email, name, avatar_url, email_verified_at, status
           FROM users
          WHERE (id = ANY($1) OR email_normalized = ANY($2)) AND status <> 'deleted'`,
        [ids, emails],
      );
      return { data: users };
    },
  );

  app.get('/internal/users/:userId', { preHandler: requireInternal() }, async (request) => {
    const user = await db.one(
      `SELECT id, email, name, avatar_url, phone, locale, timezone, email_verified_at, status, created_at
         FROM users WHERE id = $1`,
      [request.params.userId],
    );
    if (!user) throw notFound('User');
    return { data: user };
  });

  /**
   * Revoke every session for a user in one org — used when tenancy removes a
   * member or suspends them. Access is cut within the access-token lifetime.
   */
  app.post('/internal/sessions/revoke', { preHandler: requireInternal() }, async (request) => {
    const { user_id: userId, org_id: orgId, reason = 'membership_changed' } = request.body ?? {};
    if (!userId) throw badRequest('user_id is required');

    const { rowCount } = await db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
        WHERE user_id = $1 AND revoked_at IS NULL
          AND ($2::text IS NULL OR active_org_id = $2)`,
      [userId, orgId ?? null, reason],
    );
    if (rowCount) await announceRevoked(db, { userId, all: true, reason });
    request.log.warn({ userId, orgId, count: rowCount, reason }, 'sessions revoked by internal call');
    return { data: { revoked: rowCount } };
  });
}
