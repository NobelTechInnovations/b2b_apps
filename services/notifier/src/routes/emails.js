import { body, query, validate as v, requirePermission } from '@nexus/service-kit';

/**
 * The workspace's email log, for owners and admins: every invitation,
 * reminder and customer email, and whether it went out — with the mail
 * service's reply or error, and which server handled it.
 */
export async function emailRoutes(app, { sender }) {
  const { db } = app;
  const guard = [app.loadContext, requirePermission('core.settings.manage')];

  app.get('/notifications/emails', {
    preHandler: guard,
    schema: { querystring: query({ status: v.enum(['sending', 'sent', 'logged', 'failed', 'retrying']) }) },
  }, async (request) => {
    const qs = request.query;
    const values = [request.ctx.orgId];
    const where = ['org_id = $1'];
    if (qs.status) { values.push(qs.status); where.push(`status = $${values.length}`); }
    if (qs.q?.trim()) { values.push(`%${qs.q.trim()}%`); where.push(`(to_address ILIKE $${values.length} OR subject ILIKE $${values.length})`); }
    const limit = qs.limit ?? 50;
    const clause = where.join(' AND ');
    const [rows, total, counts] = await Promise.all([
      db.rows(
        `SELECT id, to_address, template, subject, status, error, response, server, transport, attempts, created_at, updated_at
           FROM emails WHERE ${clause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${((qs.page ?? 1) - 1) * limit}`,
        values,
      ),
      db.one(`SELECT count(*)::int AS n FROM emails WHERE ${clause}`, values),
      db.rows(`SELECT status, count(*)::int AS n FROM emails WHERE org_id = $1 AND created_at > now() - interval '30 days' GROUP BY status`, [request.ctx.orgId]),
    ]);
    return {
      data: rows,
      meta: {
        total: total.n, page: qs.page ?? 1, limit, pages: Math.ceil(total.n / limit) || 1,
        last_30_days: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        // The server answering this request — another server may be set up differently.
        this_server: { server: sender.server, transport: sender.transport, from: sender.from, configured: Boolean(sender.transport) },
      },
    };
  });

  app.post('/notifications/emails/test', {
    preHandler: guard,
    schema: { body: body({ to: v.email }) },
  }, async (request) => {
    const to = request.body?.to?.trim() || request.ctx.email;
    const result = await sender.sendTest({ to, orgId: request.ctx.orgId, data: { requested_by: request.ctx.email } });
    return { data: { to, ...result } };
  });
}
