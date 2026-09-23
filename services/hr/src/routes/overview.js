import { requirePermission } from '@nexus/service-kit';
import { ensureLeaveTypes } from '../lib/setup.js';

/** Everything the HR landing page and the platform dashboard widgets need. */
export async function overviewRoutes(app) {
  const { db } = app;

  app.get(
    '/hr/overview',
    { preHandler: [app.loadContext, requirePermission('hr.employees.view')] },
    async (request) => {
      const { orgId } = request.ctx;
      await ensureLeaveTypes(db, orgId);

      const [people, today, pendingLeave, byDepartment, occasions, joiners] = await Promise.all([
        db.one(
          `SELECT
             count(*) FILTER (WHERE status <> 'exited')::int AS headcount,
             count(*) FILTER (WHERE status = 'on_probation')::int AS on_probation,
             count(*) FILTER (WHERE status = 'on_notice')::int AS on_notice,
             count(*) FILTER (WHERE joined_on >= date_trunc('month', current_date))::int AS joined_this_month,
             count(*) FILTER (WHERE exited_on >= date_trunc('month', current_date))::int AS exited_this_month
           FROM employees WHERE org_id = $1 AND archived_at IS NULL`,
          [orgId],
        ),
        db.one(
          `SELECT
             count(*) FILTER (WHERE a.status IN ('present','remote'))::int AS present,
             count(*) FILTER (WHERE a.status = 'on_leave')::int AS on_leave,
             count(*) FILTER (WHERE a.status = 'absent')::int AS absent,
             (SELECT count(*) FROM employees
               WHERE org_id = $1 AND archived_at IS NULL AND status <> 'exited')::int AS total
           FROM attendance a
           JOIN employees e ON e.id = a.employee_id AND e.archived_at IS NULL
          WHERE a.org_id = $1 AND a.on_date = current_date`,
          [orgId],
        ),
        db.rows(
          `SELECT lr.id, lr.start_date, lr.end_date, lr.days, lr.reason,
                  e.first_name, e.last_name, e.designation,
                  lt.name AS leave_type_name, lt.colour
             FROM leave_requests lr
             JOIN employees e ON e.id = lr.employee_id
             JOIN leave_types lt ON lt.id = lr.leave_type_id
            WHERE lr.org_id = $1 AND lr.status = 'pending'
            ORDER BY lr.start_date LIMIT 8`,
          [orgId],
        ),
        db.rows(
          `SELECT d.id, d.name,
                  count(e.id) FILTER (WHERE e.status <> 'exited')::int AS headcount
             FROM departments d
             LEFT JOIN employees e ON e.department_id = d.id AND e.archived_at IS NULL
            WHERE d.org_id = $1 AND d.archived_at IS NULL
            GROUP BY d.id ORDER BY headcount DESC, d.name`,
          [orgId],
        ),
        db.rows(
          `SELECT id, first_name, last_name, designation, date_of_birth, joined_on,
                  CASE
                    WHEN extract(month from date_of_birth) = extract(month from current_date)
                     AND extract(day from date_of_birth) BETWEEN extract(day from current_date)
                                                             AND extract(day from current_date) + 7
                    THEN 'birthday' ELSE 'anniversary'
                  END AS occasion
             FROM employees
            WHERE org_id = $1 AND archived_at IS NULL AND status <> 'exited'
              AND (
                (extract(month from date_of_birth) = extract(month from current_date)
                 AND extract(day from date_of_birth) BETWEEN extract(day from current_date)
                                                         AND extract(day from current_date) + 7)
                OR
                (extract(month from joined_on) = extract(month from current_date)
                 AND extract(day from joined_on) BETWEEN extract(day from current_date)
                                                     AND extract(day from current_date) + 7
                 AND joined_on < date_trunc('year', current_date))
              )
            LIMIT 6`,
          [orgId],
        ),
        db.rows(
          `SELECT id, first_name, last_name, designation, joined_on
             FROM employees
            WHERE org_id = $1 AND archived_at IS NULL AND status <> 'exited'
            ORDER BY joined_on DESC LIMIT 5`,
          [orgId],
        ),
      ]);

      const notMarked = Math.max(
        0,
        today.total - (today.present ?? 0) - (today.on_leave ?? 0) - (today.absent ?? 0),
      );

      return {
        data: {
          people,
          today: { ...today, not_marked: notMarked },
          pending_leave: pendingLeave.map((r) => ({
            ...r,
            employee_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
          })),
          by_department: byDepartment,
          occasions: occasions.map((o) => ({
            ...o,
            name: [o.first_name, o.last_name].filter(Boolean).join(' '),
          })),
          recent_joiners: joiners.map((j) => ({
            ...j,
            name: [j.first_name, j.last_name].filter(Boolean).join(' '),
          })),
        },
      };
    },
  );

  /** Feeds the platform dashboard's HR widgets. */
  app.get(
    '/hr/widgets',
    { preHandler: [app.loadContext, requirePermission('hr.employees.view')] },
    async (request) => {
      const { orgId } = request.ctx;

      const row = await db.one(
        `SELECT
           (SELECT count(*) FROM employees
             WHERE org_id = $1 AND archived_at IS NULL AND status <> 'exited')::int AS headcount,
           (SELECT count(*) FROM attendance
             WHERE org_id = $1 AND on_date = current_date AND status IN ('present','remote'))::int AS present_today,
           (SELECT count(*) FROM attendance
             WHERE org_id = $1 AND on_date = current_date AND status = 'on_leave')::int AS on_leave,
           (SELECT count(*) FROM leave_requests
             WHERE org_id = $1 AND status = 'pending')::int AS pending_leave`,
        [orgId],
      );

      return {
        data: {
          'hr.headcount': { value: row.headcount, format: 'number' },
          'hr.present_today': { value: row.present_today, format: 'number' },
          'hr.on_leave': { value: row.on_leave, format: 'number' },
          'hr.pending_leave': { value: row.pending_leave, format: 'number' },
        },
      };
    },
  );
}
