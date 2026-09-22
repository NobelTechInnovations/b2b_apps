import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest,
} from '@nexus/service-kit';

/** One timeline for calls, meetings, emails, tasks and notes. */
export async function activityRoutes(app) {
  const { db } = app;

  app.get(
    '/crm/activities',
    {
      preHandler: [app.loadContext, requirePermission('crm.activities.view')],
      schema: {
        querystring: query({
          kind: v.enum(['call', 'meeting', 'email', 'task', 'note']),
          related_type: v.enum(['lead', 'contact', 'company', 'deal']),
          related_id: v.text(40),
          assigned_to: v.text(40),
          mine: { type: 'boolean' },
          open: { type: 'boolean' },
          overdue: { type: 'boolean' },
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'due_at', 'completed_at'] });
      const qs = request.query;

      const where = ['a.org_id = $1'];
      const values = [orgId];

      if (qs.kind) { values.push(qs.kind); where.push(`a.kind = $${values.length}`); }
      if (qs.related_type) { values.push(qs.related_type); where.push(`a.related_type = $${values.length}`); }
      if (qs.related_id) { values.push(qs.related_id); where.push(`a.related_id = $${values.length}`); }
      if (qs.assigned_to) { values.push(qs.assigned_to); where.push(`a.assigned_to = $${values.length}`); }
      if (qs.mine) { values.push(userId); where.push(`a.assigned_to = $${values.length}`); }
      if (qs.open) where.push('a.completed_at IS NULL');
      if (qs.overdue) where.push('a.completed_at IS NULL AND a.due_at < now()');
      if (qs.q) {
        values.push(`%${qs.q}%`);
        where.push(`(a.subject ILIKE $${values.length} OR a.body ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');

      const [rows, total, counts] = await Promise.all([
        db.rows(
          `SELECT a.* FROM activities a WHERE ${clause}
            ORDER BY a.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM activities a WHERE ${clause}`, values),
        db.one(
          `SELECT
             count(*) FILTER (WHERE completed_at IS NULL)::int AS open,
             count(*) FILTER (WHERE completed_at IS NULL AND due_at < now())::int AS overdue,
             count(*) FILTER (WHERE completed_at IS NULL AND due_at::date = current_date)::int AS due_today
           FROM activities WHERE org_id = $1 AND assigned_to = $2`,
          [orgId, userId],
        ),
      ]);

      return { data: rows, meta: { ...page.meta(total.n), counts } };
    },
  );

  app.post(
    '/crm/activities',
    {
      preHandler: [app.loadContext, requirePermission('crm.activities.create')],
      schema: {
        body: body(
          {
            kind: v.enum(['call', 'meeting', 'email', 'task', 'note']),
            subject: v.text(200, 1),
            body: v.longText,
            related_type: v.enum(['lead', 'contact', 'company', 'deal']),
            related_id: v.text(40),
            due_at: v.datetime,
            assigned_to: v.text(40),
            duration_minutes: v.int(0, 1440),
            outcome: v.text(200),
            completed: { type: 'boolean' },
          },
          ['kind', 'subject'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      if ((b.related_type && !b.related_id) || (b.related_id && !b.related_type)) {
        throw badRequest('related_type and related_id must be provided together.');
      }

      // Refuse to attach a note to a record that does not exist in this
      // workspace — that is how orphaned timeline entries appear.
      if (b.related_type) {
        const table = { lead: 'leads', contact: 'contacts', company: 'companies', deal: 'deals' }[b.related_type];
        const exists = await db.one(
          `SELECT 1 AS ok FROM ${table} WHERE id = $1 AND org_id = $2`,
          [b.related_id, orgId],
        );
        if (!exists) throw notFound(`Related ${b.related_type}`);
      }

      const activity = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO activities
             (id, org_id, kind, subject, body, related_type, related_id, due_at,
              assigned_to, duration_minutes, outcome, completed_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,$10),$11,$12,
                   CASE WHEN $13 THEN now() ELSE NULL END,$10)
           RETURNING *`,
          [
            id('act'), orgId, b.kind, b.subject.trim(), b.body ?? null,
            b.related_type ?? null, b.related_id ?? null, b.due_at ?? null,
            b.assigned_to ?? null, userId, b.duration_minutes ?? null,
            b.outcome ?? null, b.completed ?? false,
          ],
        );

        // Logging a call or meeting is the truest signal of contact.
        if (['call', 'meeting', 'email'].includes(b.kind) && b.related_type === 'lead') {
          await tx.query(
            `UPDATE leads SET last_contacted_at = now(),
                    status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END
              WHERE id = $1 AND org_id = $2`,
            [b.related_id, orgId],
          );
        }

        return created;
      });

      return reply.status(201).send({ data: activity });
    },
  );

  app.post(
    '/crm/activities/:activityId/complete',
    {
      preHandler: [app.loadContext, requirePermission('crm.activities.create')],
      schema: {
        params: params({ activityId: v.id('act') }),
        body: body({ outcome: v.text(200), duration_minutes: v.int(0, 1440) }),
      },
    },
    async (request) => {
      const updated = await db.one(
        `UPDATE activities
            SET completed_at = now(),
                outcome = COALESCE($3, outcome),
                duration_minutes = COALESCE($4, duration_minutes)
          WHERE id = $1 AND org_id = $2 RETURNING *`,
        [
          request.params.activityId, request.ctx.orgId,
          request.body?.outcome ?? null, request.body?.duration_minutes ?? null,
        ],
      );
      if (!updated) throw notFound('Activity');
      return { data: updated };
    },
  );

  app.delete(
    '/crm/activities/:activityId',
    {
      preHandler: [app.loadContext, requirePermission('crm.activities.create')],
      schema: { params: params({ activityId: v.id('act') }) },
    },
    async (request) => {
      const row = await db.one(
        `DELETE FROM activities WHERE id = $1 AND org_id = $2 RETURNING id`,
        [request.params.activityId, request.ctx.orgId],
      );
      if (!row) throw notFound('Activity');
      return { data: { deleted: true } };
    },
  );
}
