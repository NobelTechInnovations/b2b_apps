import { body, validate as v, notFound, forbidden } from '@nexus/service-kit';
import { listSessions, revokeSession } from '../lib/sessions.js';

export async function accountRoutes(app) {
  const { db } = app;

  app.patch(
    '/account/profile',
    {
      preHandler: app.authenticate,
      schema: {
        body: body({
          name: v.text(120, 2),
          phone: { type: 'string', maxLength: 32 },
          avatar_url: { type: 'string', maxLength: 500 },
          locale: { type: 'string', maxLength: 10 },
          timezone: { type: 'string', maxLength: 64 },
        }),
      },
    },
    async (request) => {
      const fields = ['name', 'phone', 'avatar_url', 'locale', 'timezone'].filter(
        (f) => request.body[f] !== undefined,
      );
      if (!fields.length) return { data: null };

      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const user = await db.one(
        `UPDATE users SET ${sets} WHERE id = $1 RETURNING id, email, name, avatar_url, phone, locale, timezone`,
        [request.auth.userId, ...fields.map((f) => request.body[f])],
      );
      return { data: user };
    },
  );

  app.get('/account/sessions', { preHandler: app.authenticate }, async (request) => {
    const sessions = await listSessions(db, request.auth.userId);
    return {
      data: sessions.map((s) => ({ ...s, current: s.id === request.auth.sessionId })),
    };
  });

  app.delete(
    '/account/sessions/:sessionId',
    {
      preHandler: app.authenticate,
      schema: { params: { type: 'object', properties: { sessionId: v.id('ses') }, required: ['sessionId'] } },
    },
    async (request) => {
      const session = await db.one(`SELECT user_id FROM sessions WHERE id = $1`, [
        request.params.sessionId,
      ]);
      if (!session) throw notFound('Session');
      if (session.user_id !== request.auth.userId) {
        throw forbidden('You can only end your own sessions.');
      }
      await revokeSession(db, request.params.sessionId, 'revoked_by_user');
      return { data: { ended: true } };
    },
  );
}
