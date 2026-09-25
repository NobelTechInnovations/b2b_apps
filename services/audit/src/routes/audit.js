import { query, validate as v, requirePermission, badRequest } from '@nexus/service-kit';
export async function auditRoutes(app) {
  app.get('/audit', { preHandler: [app.loadContext, requirePermission('core.audit.view')],
    schema: { querystring: query({ event_type: v.text(120), actor_id: v.id('usr'),
      from: v.date, to: v.date, before: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' } }) },
  }, async r => {
    if (r.query.from && r.query.to && r.query.from > r.query.to) throw badRequest('Start date must be before end date.');
    if (r.query.before && BigInt(r.query.before) > 9223372036854775807n) throw badRequest('Invalid cursor.');
    const values = [r.ctx.orgId], where = ['org_id=$1'];
    const add = (value, sql) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
    if (r.query.event_type) add(r.query.event_type, 'event_type=?');
    if (r.query.actor_id) add(r.query.actor_id, 'actor_id=?');
    if (r.query.from) add(r.query.from, 'occurred_at >= ?::date');
    if (r.query.to) add(r.query.to, "occurred_at < ?::date + interval '1 day'");
    if (r.query.before) add(r.query.before, 'sequence < ?::bigint');
    const limit = r.query.limit ?? 50;
    values.push(limit + 1);
    const rows = await app.db.rows(`SELECT sequence::text,event_id,actor_id,event_type,resource_id,occurred_at,recorded_at
      FROM audit_events WHERE ${where.join(' AND ')} ORDER BY sequence DESC LIMIT $${values.length}`, values);
    const more = rows.length > limit, data = rows.slice(0, limit);
    return { data, meta: { next_cursor: more ? data.at(-1).sequence : null } };
  });
}
