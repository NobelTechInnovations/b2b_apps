import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest, conflict,
  nullable,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { ensureLeaveTypes } from '../lib/setup.js';
import { insertEmployee } from '../lib/employees.js';

const SORTS = ['created_at', 'joined_on', 'first_name', 'employee_code'];

export async function employeeRoutes(app) {
  const { db } = app;

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/hr/employees',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.view')],
      schema: {
        querystring: query({
          status: v.enum(['active', 'on_probation', 'on_notice', 'exited', 'on_leave']),
          department_id: v.id('dep'),
          employment_type: v.enum(['full_time', 'part_time', 'contract', 'intern', 'consultant']),
          manager_id: v.id('emp'),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: SORTS });
      const qs = request.query;

      const where = ['e.org_id = $1', 'e.archived_at IS NULL'];
      const values = [orgId];

      if (qs.status) { values.push(qs.status); where.push(`e.status = $${values.length}`); }
      if (qs.department_id) { values.push(qs.department_id); where.push(`e.department_id = $${values.length}`); }
      if (qs.employment_type) { values.push(qs.employment_type); where.push(`e.employment_type = $${values.length}`); }
      if (qs.manager_id) { values.push(qs.manager_id); where.push(`e.manager_id = $${values.length}`); }
      if (qs.q) {
        values.push(`%${qs.q}%`);
        where.push(
          `(e.first_name ILIKE $${values.length} OR e.last_name ILIKE $${values.length}
            OR e.email ILIKE $${values.length} OR e.employee_code ILIKE $${values.length}
            OR e.designation ILIKE $${values.length})`,
        );
      }

      const clause = where.join(' AND ');
      const join = `FROM employees e LEFT JOIN departments d ON d.id = e.department_id`;

      const [rows, total, stats] = await Promise.all([
        db.rows(
          `SELECT e.*, d.name AS department_name,
                  m.first_name AS manager_first_name, m.last_name AS manager_last_name
             ${join} LEFT JOIN employees m ON m.id = e.manager_id
            WHERE ${clause}
            ORDER BY e.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n ${join} WHERE ${clause}`, values),
        db.one(
          `SELECT
             count(*) FILTER (WHERE status <> 'exited')::int AS headcount,
             count(*) FILTER (WHERE status = 'on_probation')::int AS on_probation,
             count(*) FILTER (WHERE status = 'on_notice')::int AS on_notice,
             count(*) FILTER (WHERE joined_on >= date_trunc('month', current_date))::int AS joined_this_month
           FROM employees WHERE org_id = $1 AND archived_at IS NULL`,
          [orgId],
        ),
      ]);

      return { data: rows.map(shape), meta: { ...page.meta(total.n), stats } };
    },
  );

  // ═══════════════════════════════════════════════════════════════════ READ
  app.get(
    '/hr/employees/:employeeId',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.view')],
      schema: { params: params({ employeeId: v.id('emp') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const employee = await db.one(
        `SELECT e.*, d.name AS department_name,
                m.first_name AS manager_first_name, m.last_name AS manager_last_name
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
           LEFT JOIN employees m ON m.id = e.manager_id
          WHERE e.id = $1 AND e.org_id = $2 AND e.archived_at IS NULL`,
        [request.params.employeeId, orgId],
      );
      if (!employee) throw notFound('Employee');

      const year = new Date().getFullYear();

      const [reports, balances, recentLeave, attendance] = await Promise.all([
        db.rows(
          `SELECT id, first_name, last_name, designation FROM employees
            WHERE org_id = $1 AND manager_id = $2 AND archived_at IS NULL ORDER BY first_name`,
          [orgId, employee.id],
        ),
        db.rows(
          `SELECT lt.id AS leave_type_id, lt.name, lt.code, lt.colour, lt.is_paid,
                  COALESCE(lb.entitled, lt.days_per_year) AS entitled,
                  COALESCE(lb.carried, 0) AS carried,
                  COALESCE(lb.used, 0) AS used
             FROM leave_types lt
             LEFT JOIN leave_balances lb
               ON lb.leave_type_id = lt.id AND lb.employee_id = $2 AND lb.year = $3
            WHERE lt.org_id = $1 AND lt.archived_at IS NULL
            ORDER BY lt.position`,
          [orgId, employee.id, year],
        ),
        db.rows(
          `SELECT lr.*, lt.name AS leave_type_name, lt.colour FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
            WHERE lr.org_id = $1 AND lr.employee_id = $2
            ORDER BY lr.start_date DESC LIMIT 10`,
          [orgId, employee.id],
        ),
        db.rows(
          `SELECT * FROM attendance
            WHERE org_id = $1 AND employee_id = $2 AND on_date >= current_date - 13
            ORDER BY on_date DESC`,
          [orgId, employee.id],
        ),
      ]);

      return {
        data: {
          ...shape(employee),
          direct_reports: reports,
          leave_balances: balances.map((b) => ({
            ...b,
            available: Number(b.entitled) + Number(b.carried) - Number(b.used),
          })),
          recent_leave: recentLeave,
          recent_attendance: attendance,
        },
      };
    },
  );

  // ════════════════════════════════════════════════════ FROM THE WORKSPACE
  /** People who can sign in to this workspace but have no employee record. */
  app.get('/hr/employees/workspace-people', { preHandler: [app.loadContext, requirePermission('hr.employees.view')] }, async (request) => ({
    data: await app.workspacePeople.unlinked(db, request.ctx.orgId),
  }));

  /** Make them employees: new records, or existing ones with their email, linked to their login. */
  app.post(
    '/hr/employees/from-people',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.create')],
      schema: { body: body({ user_ids: { type: 'array', items: v.id('usr'), minItems: 1, maxItems: 500 } }, ['user_ids']) },
    },
    async (request, reply) => {
      const result = await app.workspacePeople.add(db, { orgId: request.ctx.orgId, actorId: request.ctx.userId, userIds: request.body.user_ids });
      return reply.status(201).send({ data: result });
    },
  );

  // ═════════════════════════════════════════════════════════════════ CREATE
  app.post(
    '/hr/employees',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.create')],
      schema: {
        body: body(
          {
            first_name: v.text(80, 1),
            last_name: v.text(80),
            employee_code: v.text(32),
            email: v.email,
            personal_email: v.email,
            phone: v.text(32),
            date_of_birth: v.date,
            gender: v.enum(['female', 'male', 'other', 'undisclosed']),
            department_id: v.id('dep'),
            designation: v.text(120),
            manager_id: v.id('emp'),
            employment_type: v.enum(['full_time', 'part_time', 'contract', 'intern', 'consultant']),
            status: v.enum(['active', 'on_probation']),
            work_location: v.text(120),
            joined_on: v.date,
            probation_ends_on: v.date,
            address: { type: 'object', additionalProperties: true },
            emergency_contact: { type: 'object', additionalProperties: true },
            notes: v.longText,
          },
          ['first_name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      // The first hire may precede anyone opening the Leave screen.
      await ensureLeaveTypes(db, orgId);

      if (b.email) {
        const clash = await db.one(
          `SELECT id, first_name, last_name FROM employees
            WHERE org_id = $1 AND lower(email) = lower($2) AND archived_at IS NULL`,
          [orgId, b.email],
        );
        if (clash) {
          throw conflict(
            `${[clash.first_name, clash.last_name].filter(Boolean).join(' ')} already uses that work email.`,
            { employee_id: clash.id },
          );
        }
      }

      const employee = await db.transaction((tx) => insertEmployee(tx, { orgId, userId, fields: b }));

      return reply.status(201).send({ data: shape(employee) });
    },
  );

  // ═════════════════════════════════════════════════════════════════ UPDATE
  app.patch(
    '/hr/employees/:employeeId',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.edit')],
      schema: {
        params: params({ employeeId: v.id('emp') }),
        // `null` clears a field: no department, no manager, no phone.
        body: body({
          first_name: v.text(80, 1), last_name: nullable(v.text(80, 0)), email: nullable(v.email),
          personal_email: nullable(v.email), phone: nullable(v.text(32, 0)), date_of_birth: nullable(v.date),
          gender: nullable(v.enum(['female', 'male', 'other', 'undisclosed'])),
          department_id: nullable(v.id('dep')), designation: nullable(v.text(120, 0)), manager_id: nullable(v.id('emp')),
          employment_type: v.enum(['full_time', 'part_time', 'contract', 'intern', 'consultant']),
          status: v.enum(['active', 'on_probation', 'on_notice', 'on_leave']),
          work_location: nullable(v.text(120, 0)), joined_on: v.date, probation_ends_on: nullable(v.date),
          address: { type: 'object', additionalProperties: true },
          emergency_contact: { type: 'object', additionalProperties: true },
          notes: nullable(v.longText),
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      // Nobody may be their own manager, and a chain must not loop back.
      if (request.body.manager_id) {
        if (request.body.manager_id === request.params.employeeId) {
          throw badRequest('Someone cannot report to themselves.');
        }
        const loops = await managerLoops(db, orgId, request.params.employeeId, request.body.manager_id);
        if (loops) throw badRequest('That would create a circular reporting line.');
      }

      // Someone who left comes back through Re-hire, which also clears their exit.
      if (request.body.status !== undefined) {
        const current = await db.one(`SELECT status FROM employees WHERE id = $1 AND org_id = $2`, [request.params.employeeId, orgId]);
        if (current?.status === 'exited') throw badRequest('This person was offboarded. Use Re-hire to bring them back.');
      }

      const fields = [
        'first_name', 'last_name', 'email', 'personal_email', 'phone', 'date_of_birth',
        'gender', 'department_id', 'designation', 'manager_id', 'employment_type',
        'status', 'work_location', 'joined_on', 'probation_ends_on', 'address',
        'emergency_contact', 'notes',
      ].filter((f) => request.body[f] !== undefined);

      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const values = fields.map((f) =>
        ['address', 'emergency_contact'].includes(f) ? JSON.stringify(request.body[f]) : request.body[f],
      );

      const updated = await db.one(
        `UPDATE employees SET ${sets} WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`,
        [request.params.employeeId, orgId, ...values],
      );
      if (!updated) throw notFound('Employee');

      await db.query(
        `INSERT INTO outbox (id, type, org_id, actor_id, data) VALUES ($1,$2,$3,$4,$5)`,
        [id('evt'), EVENTS.EMPLOYEE_UPDATED, orgId, userId,
         JSON.stringify({ employee_id: updated.id, changed: fields })],
      );

      return { data: shape(updated) };
    },
  );

  // ═══════════════════════════════════════════════════════════════ OFFBOARD
  app.post(
    '/hr/employees/:employeeId/offboard',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.edit')],
      schema: {
        params: params({ employeeId: v.id('emp') }),
        body: body({ exited_on: v.date, exit_reason: v.text(240), reassign_reports_to: v.id('emp') }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const b = request.body ?? {};

      const employee = await db.one(
        `SELECT * FROM employees WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.employeeId, orgId],
      );
      if (!employee) throw notFound('Employee');
      if (employee.status === 'exited') throw badRequest('This person has already been offboarded.');

      const result = await db.transaction(async (tx) => {
        // Never leave a team without a manager.
        const reports = await tx.rows(
          `SELECT id FROM employees WHERE org_id = $1 AND manager_id = $2 AND archived_at IS NULL`,
          [orgId, employee.id],
        );

        if (reports.length) {
          await tx.query(
            `UPDATE employees SET manager_id = $3 WHERE org_id = $1 AND manager_id = $2`,
            [orgId, employee.id, b.reassign_reports_to ?? employee.manager_id ?? null],
          );
        }

        // Pending leave for someone who has left is meaningless.
        const cancelled = await tx.rows(
          `UPDATE leave_requests SET status = 'cancelled',
                  decision_note = 'Employee offboarded', decided_at = now()
            WHERE org_id = $1 AND employee_id = $2 AND status = 'pending'
          RETURNING id`,
          [orgId, employee.id],
        );

        const row = await tx.one(
          `UPDATE employees
              SET status = 'exited',
                  exited_on = COALESCE($3::date, current_date),
                  exit_reason = $4
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [employee.id, orgId, b.exited_on ?? null, b.exit_reason ?? null],
        );

        tx.emit({
          type: EVENTS.EMPLOYEE_OFFBOARDED,
          org_id: orgId,
          actor_id: userId,
          data: {
            employee_id: row.id,
            name: [row.first_name, row.last_name].filter(Boolean).join(' '),
            exited_on: row.exited_on,
            reason: row.exit_reason,
            reports_reassigned: reports.length,
          },
        });

        return { employee: row, reports: reports.length, cancelled: cancelled.length };
      });

      return {
        data: {
          offboarded: true,
          exited_on: result.employee.exited_on,
          reports_reassigned: result.reports,
          leave_requests_cancelled: result.cancelled,
        },
      };
    },
  );

  // ════════════════════════════════════════════════════════════════ RE-HIRE
  /**
   * Bring back someone who was offboarded: active again from their new
   * joining date, exit cleared, same employee code and history (a note
   * records when they left and why). Attendance, leave, payroll and the
   * portal pick them up again because they key off the status.
   */
  app.post(
    '/hr/employees/:employeeId/rehire',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.edit')],
      schema: {
        params: params({ employeeId: v.id('emp') }),
        body: body({
          joined_on: v.date,
          status: v.enum(['active', 'on_probation']),
          designation: v.text(120),
          department_id: v.id('dep'),
          manager_id: v.id('emp'),
          employment_type: v.enum(['full_time', 'part_time', 'contract', 'intern', 'consultant']),
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const b = request.body ?? {};
      const employee = await db.one(
        `SELECT * FROM employees WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.employeeId, orgId],
      );
      if (!employee) throw notFound('Employee');
      if (employee.status !== 'exited') throw badRequest('Only someone who has been offboarded can be re-hired.');
      if (b.manager_id) {
        if (b.manager_id === employee.id) throw badRequest('Someone cannot report to themselves.');
        if (await managerLoops(db, orgId, employee.id, b.manager_id)) throw badRequest('That would create a circular reporting line.');
      }
      await ensureLeaveTypes(db, orgId);

      const left = employee.exited_on ? new Date(employee.exited_on).toISOString().slice(0, 10) : 'an earlier date';
      const row = await db.transaction(async (tx) => {
        const updated = await tx.one(
          `UPDATE employees
              SET status = COALESCE($3, 'active'), joined_on = COALESCE($4::date, current_date),
                  exited_on = NULL, exit_reason = NULL,
                  designation = COALESCE($5, designation), department_id = COALESCE($6, department_id),
                  manager_id = COALESCE($7, manager_id), employment_type = COALESCE($8, employment_type),
                  notes = concat_ws(E'\n', notes, $9::text), updated_at = now()
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [employee.id, orgId, b.status ?? null, b.joined_on ?? null, b.designation ?? null, b.department_id ?? null,
            b.manager_id ?? null, b.employment_type ?? null,
            `Re-hired on ${b.joined_on ?? new Date().toISOString().slice(0, 10)}; previously left on ${left}${employee.exit_reason ? ` (${employee.exit_reason})` : ''}.`],
        );
        // This year's leave starts again from the policy, where it is missing.
        await tx.query(
          `INSERT INTO leave_balances (org_id, employee_id, leave_type_id, year, entitled)
           SELECT $1, $2, lt.id, $3, lt.days_per_year FROM leave_types lt WHERE lt.org_id = $1 AND lt.archived_at IS NULL
           ON CONFLICT DO NOTHING`,
          [orgId, employee.id, new Date().getFullYear()],
        );
        await tx.query(
          `INSERT INTO outbox (id, type, org_id, actor_id, data) VALUES ($1,$2,$3,$4,$5)`,
          [id('evt'), EVENTS.EMPLOYEE_UPDATED, orgId, userId, JSON.stringify({ employee_id: employee.id, changed: ['status', 'joined_on'], rehired: true })],
        );
        return updated;
      });
      return { data: shape(row) };
    },
  );

  app.delete(
    '/hr/employees/:employeeId',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.delete')],
      schema: { params: params({ employeeId: v.id('emp') }) },
    },
    async (request) => {
      const row = await db.one(
        `UPDATE employees SET archived_at = now()
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`,
        [request.params.employeeId, request.ctx.orgId],
      );
      if (!row) throw notFound('Employee');
      return { data: { archived: true } };
    },
  );
}

/** Walks up the reporting chain looking for `employeeId`. */
async function managerLoops(db, orgId, employeeId, proposedManagerId, depth = 0) {
  if (depth > 20) return true;
  if (proposedManagerId === employeeId) return true;

  const manager = await db.one(
    `SELECT manager_id FROM employees WHERE id = $1 AND org_id = $2`,
    [proposedManagerId, orgId],
  );
  if (!manager?.manager_id) return false;

  return managerLoops(db, orgId, employeeId, manager.manager_id, depth + 1);
}

function shape(employee) {
  return {
    ...employee,
    name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
    manager_name: employee.manager_first_name
      ? [employee.manager_first_name, employee.manager_last_name].filter(Boolean).join(' ')
      : null,
  };
}
