import { id } from '@nexus/db-kit';
import {
  requirePermission, body, params, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';

export async function departmentRoutes(app) {
  const { db } = app;

  app.get(
    '/hr/departments',
    { preHandler: [app.loadContext, requirePermission('hr.departments.view')] },
    async (request) => {
      const rows = await db.rows(
        `SELECT d.*,
                (SELECT count(*)::int FROM employees e
                  WHERE e.department_id = d.id AND e.archived_at IS NULL AND e.status <> 'exited') AS headcount,
                h.first_name AS head_first_name, h.last_name AS head_last_name
           FROM departments d
           LEFT JOIN employees h ON h.id = d.head_employee_id
          WHERE d.org_id = $1 AND d.archived_at IS NULL
          ORDER BY d.name`,
        [request.ctx.orgId],
      );

      return {
        data: rows.map((r) => ({
          ...r,
          head_name: r.head_first_name
            ? [r.head_first_name, r.head_last_name].filter(Boolean).join(' ')
            : null,
        })),
      };
    },
  );

  app.post(
    '/hr/departments',
    {
      preHandler: [app.loadContext, requirePermission('hr.departments.manage')],
      schema: {
        body: body(
          {
            name: v.text(120, 1),
            code: v.text(20),
            parent_id: v.id('dep'),
            head_employee_id: v.id('emp'),
            description: v.text(500),
          },
          ['name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId } = request.ctx;
      const b = request.body;

      const clash = await db.one(
        `SELECT id FROM departments WHERE org_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL`,
        [orgId, b.name.trim()],
      );
      if (clash) throw conflict('A department with that name already exists.');

      const department = await db.one(
        `INSERT INTO departments (id, org_id, name, code, parent_id, head_employee_id, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          id('dep'), orgId, b.name.trim(), b.code ?? null,
          b.parent_id ?? null, b.head_employee_id ?? null, b.description ?? null,
        ],
      );

      return reply.status(201).send({ data: { ...department, headcount: 0 } });
    },
  );

  app.patch(
    '/hr/departments/:departmentId',
    {
      preHandler: [app.loadContext, requirePermission('hr.departments.manage')],
      schema: {
        params: params({ departmentId: v.id('dep') }),
        body: body({
          name: v.text(120, 1), code: v.text(20), parent_id: v.id('dep'),
          head_employee_id: v.id('emp'), description: v.text(500),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;

      if (request.body.parent_id === request.params.departmentId) {
        throw badRequest('A department cannot be its own parent.');
      }

      const fields = ['name', 'code', 'parent_id', 'head_employee_id', 'description']
        .filter((f) => request.body[f] !== undefined);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const updated = await db.one(
        `UPDATE departments SET ${sets}
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
        [request.params.departmentId, orgId, ...fields.map((f) => request.body[f])],
      );
      if (!updated) throw notFound('Department');

      return { data: updated };
    },
  );

  app.delete(
    '/hr/departments/:departmentId',
    {
      preHandler: [app.loadContext, requirePermission('hr.departments.manage')],
      schema: { params: params({ departmentId: v.id('dep') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      // Do not strand people in a department that no longer exists.
      const staffed = await db.one(
        `SELECT count(*)::int AS n FROM employees
          WHERE org_id = $1 AND department_id = $2 AND archived_at IS NULL`,
        [orgId, request.params.departmentId],
      );
      if (staffed.n > 0) {
        throw badRequest(
          `${staffed.n} ${staffed.n === 1 ? 'person is' : 'people are'} in this department. Move them first.`,
        );
      }

      const row = await db.one(
        `UPDATE departments SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`,
        [request.params.departmentId, orgId],
      );
      if (!row) throw notFound('Department');

      return { data: { archived: true } };
    },
  );
}
