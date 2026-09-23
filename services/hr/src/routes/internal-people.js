import { requireInternal, validate as v } from '@nexus/service-kit';

/**
 * The employee roster, for services that pay people or assign work to them.
 *
 * This is the only way out of HR's database. Callers get a flat, snapshot-
 * shaped record — no joins to follow, no ids that only mean something here —
 * precisely so they can copy what they need and stop depending on us.
 */
export async function internalPeopleRoutes(app) {
  const { db } = app;

  app.get(
    '/internal/employees',
    {
      preHandler: [requireInternal()],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            org_id: { type: 'string', minLength: 1, maxLength: 64 },
            employee_ids: { type: 'string', maxLength: 20_000 },
            // Anybody who had left before payroll's period began is excluded
            // by the caller passing the period start, not by us guessing.
            active_on: v.date,
          },
          required: ['org_id'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { org_id: orgId } = request.query;
      const values = [orgId];
      let filter = '';

      if (request.query.employee_ids) {
        values.push(request.query.employee_ids.split(',').filter(Boolean));
        filter += ` AND e.id = ANY($${values.length}::text[])`;
      }
      if (request.query.active_on) {
        values.push(request.query.active_on);
        filter += ` AND (e.joined_on IS NULL OR e.joined_on <= $${values.length}::date)
                    AND (e.exited_on IS NULL OR e.exited_on >= $${values.length}::date)`;
      } else {
        filter += ` AND e.status <> 'exited'`;
      }

      const rows = await db.rows(
        `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.designation,
                e.employment_type, e.status, e.joined_on, e.exited_on, e.email,
                d.name AS department_name, d.id AS department_id
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
          WHERE e.org_id = $1 AND e.archived_at IS NULL ${filter}
          ORDER BY e.employee_code NULLS LAST, e.first_name`,
        values,
      );

      return {
        data: rows.map((r) => ({
          ...r,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        })),
        meta: { total: rows.length, org_id: orgId },
      };
    },
  );
}
