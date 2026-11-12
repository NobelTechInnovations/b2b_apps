import { body, query, validate as v, requirePermission, badRequest, nullable } from '@nexus/service-kit';
import { explainSmtpError, openPassword, sealPassword, settingsTransport } from '../lib/mail-settings.js';

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
        // How this workspace's email goes out, from the server answering this request.
        this_server: { server: sender.server, ...(await sender.describe(request.ctx.orgId)) },
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

  // ═══════════════════════════════════════════════ THE WORKSPACE'S MAIL SERVER
  const present = (row) => (row ? {
    host: row.host, port: row.port, username: row.username, from_email: row.from_email, from_name: row.from_name,
    reply_to: row.reply_to, enabled: row.enabled, verified_at: row.verified_at, updated_at: row.updated_at,
    // The password never leaves the server; only whether one is saved and still readable.
    has_password: Boolean(openPassword(row.password_sealed, app.config.serviceToken)),
  } : null);

  app.get('/notifications/mail-settings', { preHandler: guard }, async (request) => ({
    data: present(await db.one(`SELECT * FROM mail_settings WHERE org_id = $1`, [request.ctx.orgId])),
  }));

  app.put('/notifications/mail-settings', {
    preHandler: guard,
    schema: {
      body: body({
        host: { type: 'string', minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' },
        port: v.int(1, 65535),
        username: v.text(200, 1),
        // Left out when editing: the saved one is kept.
        password: { type: 'string', minLength: 1, maxLength: 300 },
        from_email: v.email,
        from_name: v.text(120, 0),
        reply_to: nullable(v.email),
        enabled: v.bool,
      }, ['host', 'port', 'username', 'from_email']),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const saved = await db.one(`SELECT * FROM mail_settings WHERE org_id = $1`, [orgId]);
    // Google shows App Passwords in groups of four; the spaces are not part of it.
    const typed = /gmail\.com$|googlemail\.com$/i.test(b.host) ? b.password?.replace(/\s+/g, '') : b.password;
    const password = typed || (saved ? openPassword(saved.password_sealed, app.config.serviceToken) : null);
    if (!password) throw badRequest('Enter the password (for Gmail, an App Password).', [{ field: 'password', message: 'Enter the password.' }]);
    const settings = {
      host: b.host.trim().toLowerCase(), port: b.port, username: b.username.trim(), from_email: b.from_email.trim().toLowerCase(),
      from_name: b.from_name?.trim() || null, reply_to: b.reply_to?.trim() || null,
    };
    // Log in once before saving, so a wrong password or a blocked port shows now, not on the next email.
    try {
      await settingsTransport(settings, password).verify();
    } catch (error) {
      throw badRequest(explainSmtpError(error, settings.host), [{ field: error.code === 'EAUTH' ? 'password' : 'host', message: 'Check this.' }]);
    }
    const row = await db.one(
      `INSERT INTO mail_settings (org_id, host, port, username, password_sealed, from_email, from_name, reply_to, enabled, verified_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)
       ON CONFLICT (org_id) DO UPDATE SET host = $2, port = $3, username = $4, password_sealed = $5, from_email = $6, from_name = $7,
              reply_to = $8, enabled = $9, verified_at = now(), updated_by = $10, updated_at = now()
       RETURNING *`,
      [orgId, settings.host, settings.port, settings.username, sealPassword(password, app.config.serviceToken), settings.from_email,
        settings.from_name, settings.reply_to, b.enabled ?? true, userId],
    );
    sender.forget();
    return { data: present(row) };
  });

  app.delete('/notifications/mail-settings', { preHandler: guard }, async (request) => {
    await db.query(`DELETE FROM mail_settings WHERE org_id = $1`, [request.ctx.orgId]);
    sender.forget();
    return { data: { deleted: true } };
  });
}
