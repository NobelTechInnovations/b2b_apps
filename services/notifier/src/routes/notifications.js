import {
  body, query, validate as v, badRequest,
} from '@nexus/service-kit';

/**
 * The inbox.
 *
 * Every route is scoped to the signed-in user and their current workspace —
 * there is no way to name somebody else's notifications, because no route
 * takes a user id.
 */
export async function notificationRoutes(app) {
  const { db } = app;

  app.get(
    '/notifications',
    {
      preHandler: [app.loadContext],
      schema: { querystring: query({ unread: v.bool }) },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const limit = Math.min(request.query.limit ?? 30, 100);

      const rows = await db.rows(
        `SELECT id, kind, app, title, body, link, actor_id, read_at, created_at
           FROM notifications
          WHERE org_id = $1 AND user_id = $2 ${request.query.unread ? 'AND read_at IS NULL' : ''}
          ORDER BY created_at DESC
          LIMIT ${limit}`,
        [orgId, userId],
      );

      const unread = await db.one(
        `SELECT count(*)::int AS n FROM notifications
          WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`,
        [orgId, userId],
      );

      return { data: rows, meta: { unread: unread.n } };
    },
  );

  /** The number on the bell. Cheap, because the topbar polls it. */
  app.get(
    '/notifications/unread-count',
    { preHandler: [app.loadContext] },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const row = await db.one(
        `SELECT count(*)::int AS n FROM notifications
          WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`,
        [orgId, userId],
      );
      return { data: { unread: row.n } };
    },
  );

  app.post(
    '/notifications/read',
    {
      preHandler: [app.loadContext],
      schema: {
        body: body({
          ids: { type: 'array', items: v.id('ntf'), maxItems: 200 },
          all: v.bool,
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const { ids, all } = request.body;
      if (!all && !ids?.length) throw badRequest('Say which notifications, or all of them.');

      const result = all
        ? await db.query(
            `UPDATE notifications SET read_at = now()
              WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`,
            [orgId, userId],
          )
        : await db.query(
            `UPDATE notifications SET read_at = now()
              WHERE org_id = $1 AND user_id = $2 AND id = ANY($3::text[]) AND read_at IS NULL`,
            [orgId, userId, ids],
          );

      return { data: { marked: result.rowCount } };
    },
  );
}
