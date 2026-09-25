import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, requireInternal, body, query, params, validate as v, notFound, badRequest,
} from '@nexus/service-kit';
import { deriveDay, formatMinutes } from '../lib/time.js';
import { shiftForEmployee, ensureDefaultShift, periodSummary } from '../lib/shifts.js';
import { toISODate } from '../lib/setup.js';
import { writeManualDay, raiseRequest, decideRequest } from '../lib/attendance.js';

export async function attendanceRoutes(app) {
  const { db } = app;

  // ══════════════════════════════════════════════════════════ TODAY'S BOARD
  /** Who is in, who is out, who is on leave — the screen people actually open. */
  app.get(
    '/hr/attendance/today',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.view')],
      schema: { querystring: query({ on_date: v.date, department_id: v.id('dep') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const onDate = request.query.on_date ?? null;

      const values = [orgId, onDate];
      let filter = '';
      if (request.query.department_id) {
        values.push(request.query.department_id);
        filter = `AND e.department_id = $${values.length}`;
      }

      const rows = await db.rows(
        `SELECT e.id AS employee_id, e.first_name, e.last_name, e.employee_code,
                e.designation, d.name AS department_name,
                a.id AS attendance_id, a.status, a.check_in_at, a.check_out_at,
                a.work_minutes, a.notes, a.overtime_minutes, a.shortfall_minutes,
                a.late_minutes, a.early_exit_minutes, a.expected_minutes, a.source,
                s.name AS shift_name, s.starts_at, s.ends_at
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
           LEFT JOIN attendance a
             ON a.employee_id = e.id AND a.on_date = COALESCE($2::date, current_date)
           LEFT JOIN shifts s ON s.id = a.shift_id
          WHERE e.org_id = $1 AND e.archived_at IS NULL AND e.status <> 'exited' ${filter}
          ORDER BY e.first_name, e.last_name`,
        values,
      );

      const counts = rows.reduce(
        (acc, row) => {
          const status = row.status ?? 'not_marked';
          acc[status] = (acc[status] ?? 0) + 1;
          return acc;
        },
        { present: 0, absent: 0, on_leave: 0, remote: 0, half_day: 0, not_marked: 0 },
      );

      const overtime = rows.reduce((sum, r) => sum + (r.overtime_minutes ?? 0), 0);
      const late = rows.filter((r) => (r.late_minutes ?? 0) > 0).length;

      return {
        data: rows.map((r) => ({
          ...r,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
          status: r.status ?? 'not_marked',
          shift_window: r.starts_at
            ? `${String(r.starts_at).slice(0, 5)}–${String(r.ends_at).slice(0, 5)}`
            : null,
          worked: formatMinutes(r.work_minutes),
          overtime: r.overtime_minutes ? formatMinutes(r.overtime_minutes) : null,
        })),
        meta: {
          date: onDate ?? toISODate(new Date()),
          counts,
          total: rows.length,
          overtime_minutes: overtime,
          overtime_hours: formatMinutes(overtime),
          late_arrivals: late,
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════════ MARK
  app.post(
    '/hr/attendance',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.edit')],
      schema: {
        body: body(
          {
            employee_id: v.id('emp'),
            on_date: v.date,
            status: v.enum(['present', 'absent', 'half_day', 'remote', 'holiday', 'weekend']),
            check_in_at: v.datetime,
            check_out_at: v.datetime,
            notes: v.text(240),
          },
          ['employee_id', 'status'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      const onDate = b.on_date ?? toISODate(new Date());

      /*
       * A typed-in day is a claim, not evidence. Someone who can approve
       * attendance records it directly; anyone else raises a request that an
       * approver has to accept before it reaches the table payroll reads.
       */
      if (!request.ctx.can('hr.attendance.approve')) {
        const pending = await raiseRequest(db, {
          orgId, employeeId: b.employee_id, onDate, status: b.status,
          checkIn: b.check_in_at, checkOut: b.check_out_at, reason: b.notes,
          via: 'hr', actorId: userId,
        });
        return reply.status(202).send({ data: { pending: true, request: pending } });
      }

      const employee = await db.one(
        `SELECT id FROM employees WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [b.employee_id, orgId],
      );
      if (!employee) throw notFound('Employee');

      const row = await writeManualDay(db, {
        orgId, employeeId: b.employee_id, onDate, status: b.status,
        checkIn: b.check_in_at, checkOut: b.check_out_at, notes: b.notes,
        actorId: userId, approvedBy: userId,
      });

      return { data: row };
    },
  );

  // ══════════════════════════════════════════════════════════════ CHECK IN
  app.post(
    '/hr/attendance/check-in',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.edit')],
      schema: { body: body({ employee_id: v.id('emp'), remote: { type: 'boolean' } }, ['employee_id']) },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;

      const existing = await db.one(
        `SELECT * FROM attendance
          WHERE org_id = $1 AND employee_id = $2 AND on_date = current_date`,
        [orgId, request.body.employee_id],
      );
      if (existing?.check_in_at) {
        throw badRequest('Already checked in today.', { checked_in_at: existing.check_in_at });
      }

      // The button is a manual entry like any other: without approval rights
      // it becomes a request. The punch terminal is what records days
      // without anybody having to sign them off.
      if (!request.ctx.can('hr.attendance.approve')) {
        const pending = await raiseRequest(db, {
          orgId, employeeId: request.body.employee_id, onDate: toISODate(new Date()),
          status: request.body.remote ? 'remote' : 'present',
          checkIn: new Date().toISOString(), via: 'check_in', actorId: userId,
        });
        return reply.status(202).send({ data: { pending: true, request: pending } });
      }

      const onDate = toISODate(new Date());
      await ensureDefaultShift(db, orgId);
      const shift = await shiftForEmployee(db, orgId, request.body.employee_id, onDate);
      const derived = deriveDay({ shift, onDate, checkIn: new Date().toISOString(), checkOut: null, workMinutes: null });

      const row = await db.one(
        `INSERT INTO attendance
           (id, org_id, employee_id, on_date, status, check_in_at, recorded_by,
            shift_id, expected_minutes, late_minutes, source)
         VALUES ($1,$2,$3,current_date,$4,now(),$5,$6,$7,$8,'self')
         ON CONFLICT (org_id, employee_id, on_date) DO UPDATE SET
           check_in_at = now(), status = EXCLUDED.status,
           shift_id = EXCLUDED.shift_id, expected_minutes = EXCLUDED.expected_minutes,
           late_minutes = EXCLUDED.late_minutes,
           approved_by = EXCLUDED.recorded_by, approved_at = now(), updated_at = now()
         RETURNING *`,
        [
          id('att'), orgId, request.body.employee_id,
          request.body.remote ? 'remote' : 'present', userId,
          shift?.id ?? null, derived.expected_minutes, derived.late_minutes,
        ],
      );

      return {
        data: {
          ...row,
          shift_name: shift?.name ?? null,
          late: derived.late_minutes > 0 ? formatMinutes(derived.late_minutes) : null,
        },
      };
    },
  );

  app.post(
    '/hr/attendance/check-out',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.edit')],
      schema: { body: body({ employee_id: v.id('emp') }, ['employee_id']) },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;

      if (!request.ctx.can('hr.attendance.approve')) {
        // Completes the open request from this morning's check-in, if there
        // is one, rather than filing a second claim for the same day.
        const pending = await raiseRequest(db, {
          orgId, employeeId: request.body.employee_id, onDate: toISODate(new Date()),
          checkOut: new Date().toISOString(), via: 'check_in', actorId: userId,
        });
        return reply.status(202).send({ data: { pending: true, request: pending } });
      }

      const existing = await db.one(
        `SELECT * FROM attendance
          WHERE org_id = $1 AND employee_id = $2 AND on_date = current_date`,
        [orgId, request.body.employee_id],
      );
      if (!existing?.check_in_at) throw badRequest('No check-in recorded for today.');
      if (existing.check_out_at) {
        throw badRequest('Already checked out today.', { checked_out_at: existing.check_out_at });
      }

      const onDate = toISODate(existing.on_date);
      const shift = await shiftForEmployee(db, orgId, request.body.employee_id, onDate);
      const derived = deriveDay({
        shift,
        onDate,
        checkIn: existing.check_in_at,
        checkOut: new Date().toISOString(),
        workMinutes: null,
        status: existing.status,
      });

      const row = await db.one(
        `UPDATE attendance
            SET check_out_at = now(), work_minutes = $3, shift_id = $4,
                expected_minutes = $5, overtime_minutes = $6, shortfall_minutes = $7,
                early_exit_minutes = $8
          WHERE id = $1 AND org_id = $2 RETURNING *`,
        [
          existing.id, orgId, derived.work_minutes, shift?.id ?? null,
          derived.expected_minutes, derived.overtime_minutes,
          derived.shortfall_minutes, derived.early_exit_minutes,
        ],
      );

      return {
        data: {
          ...row,
          worked: formatMinutes(row.work_minutes),
          overtime: row.overtime_minutes ? formatMinutes(row.overtime_minutes) : null,
        },
      };
    },
  );

  // ═══════════════════════════════════════════════════════ APPROVAL QUEUE
  /** Manual entries waiting for somebody to accept or reject them. */
  app.get(
    '/hr/attendance/requests',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.view')],
      schema: {
        querystring: query({
          decision: v.enum(['pending', 'approved', 'rejected', 'withdrawn']),
          employee_id: v.id('emp'),
        }),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const qs = request.query;

      const values = [orgId, qs.decision ?? 'pending'];
      let filter = '';
      if (qs.employee_id) { values.push(qs.employee_id); filter = ` AND r.employee_id = $${values.length}`; }

      const rows = await db.rows(
        `SELECT r.*, e.first_name, e.last_name, e.employee_code, e.designation,
                a.status AS current_status, a.check_in_at AS current_check_in,
                a.check_out_at AS current_check_out, a.source AS current_source
           FROM attendance_requests r
           JOIN employees e ON e.id = r.employee_id
           LEFT JOIN attendance a
             ON a.org_id = r.org_id AND a.employee_id = r.employee_id AND a.on_date = r.on_date
          WHERE r.org_id = $1 AND r.decision = $2 ${filter}
          ORDER BY r.on_date DESC, r.created_at DESC
          LIMIT 200`,
        values,
      );

      const pending = await db.one(
        `SELECT count(*)::int AS n FROM attendance_requests WHERE org_id = $1 AND decision = 'pending'`,
        [orgId],
      );

      return {
        data: rows.map((r) => ({
          ...r,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
          // The screen greys out the buttons rather than letting an approver
          // click into a refusal.
          is_own: r.requested_by === userId,
          overrides_device: r.current_source === 'device',
        })),
        meta: { pending: pending.n, can_approve: request.ctx.can('hr.attendance.approve') },
      };
    },
  );

  app.post(
    '/hr/attendance/requests/:requestId/decide',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.approve')],
      schema: {
        params: params({ requestId: v.id('arq') }),
        body: body(
          { decision: v.enum(['approved', 'rejected']), note: v.text(500) },
          ['decision'],
        ),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      if (request.body.decision === 'rejected' && !request.body.note?.trim()) {
        // The person reading the rejection deserves to know why.
        throw badRequest('Say why you are rejecting it.');
      }

      const result = await decideRequest(db, {
        orgId,
        requestId: request.params.requestId,
        decision: request.body.decision,
        note: request.body.note,
        actorId: userId,
      });

      return { data: result };
    },
  );

  // ══════════════════════════════════════════════════════════════════ LOG
  app.get(
    '/hr/attendance',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.view')],
      schema: {
        querystring: query({
          employee_id: v.id('emp'),
          from: v.date,
          to: v.date,
          status: v.enum(['present', 'absent', 'half_day', 'on_leave', 'remote', 'holiday', 'weekend']),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['on_date', 'created_at'] });
      const qs = request.query;

      const where = ['a.org_id = $1'];
      const values = [orgId];

      if (qs.employee_id) { values.push(qs.employee_id); where.push(`a.employee_id = $${values.length}`); }
      if (qs.from) { values.push(qs.from); where.push(`a.on_date >= $${values.length}`); }
      if (qs.to) { values.push(qs.to); where.push(`a.on_date <= $${values.length}`); }
      if (qs.status) { values.push(qs.status); where.push(`a.status = $${values.length}`); }

      const clause = where.join(' AND ');
      const join = `FROM attendance a JOIN employees e ON e.id = a.employee_id`;

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT a.*, e.first_name, e.last_name, e.employee_code ${join}
            WHERE ${clause} ORDER BY a.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n ${join} WHERE ${clause}`, values),
      ]);

      return {
        data: rows.map((r) => ({
          ...r,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        })),
        meta: page.meta(total.n),
      };
    },
  );

  // ════════════════════════════════════════════════════ OVERTIME & SHORT TIME
  /**
   * The exception report: who worked beyond their shift and who fell short.
   *
   * Ranked by net minutes rather than gross, because a week of two hours over
   * and two hours under is not the same story as a week of four hours over.
   */
  app.get(
    '/hr/attendance/overtime',
    {
      preHandler: [app.loadContext, requirePermission('hr.attendance.view')],
      schema: {
        querystring: query({
          from: v.date,
          to: v.date,
          department_id: v.id('dep'),
          employee_id: v.id('emp'),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;

      // Default to the current month — the period anybody actually asks about.
      const today = new Date();
      const from = request.query.from ?? toISODate(new Date(today.getFullYear(), today.getMonth(), 1));
      const to = request.query.to ?? toISODate(today);

      const values = [orgId, from, to];
      let filter = '';
      if (request.query.department_id) {
        values.push(request.query.department_id);
        filter += ` AND e.department_id = $${values.length}`;
      }
      if (request.query.employee_id) {
        values.push(request.query.employee_id);
        filter += ` AND e.id = $${values.length}`;
      }

      const rows = await db.rows(
        `SELECT e.id AS employee_id, e.first_name, e.last_name, e.employee_code, e.designation,
                d.name AS department_name,
                count(*) FILTER (WHERE a.status IN ('present','remote'))::int AS days_present,
                count(*) FILTER (WHERE a.status = 'half_day')::int             AS days_half,
                count(*) FILTER (WHERE a.status = 'absent')::int               AS days_absent,
                count(*) FILTER (WHERE a.overtime_minutes > 0)::int            AS days_overtime,
                count(*) FILTER (WHERE a.late_minutes > 0)::int                AS days_late,
                COALESCE(sum(a.work_minutes), 0)::int                          AS work_minutes,
                COALESCE(sum(a.expected_minutes), 0)::int                      AS expected_minutes,
                COALESCE(sum(a.overtime_minutes), 0)::int                      AS overtime_minutes,
                COALESCE(sum(a.shortfall_minutes), 0)::int                     AS shortfall_minutes,
                COALESCE(sum(a.late_minutes), 0)::int                          AS late_minutes
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
           LEFT JOIN attendance a ON a.employee_id = e.id
                                 AND a.on_date BETWEEN $2::date AND $3::date
          WHERE e.org_id = $1 AND e.archived_at IS NULL AND e.status <> 'exited' ${filter}
          GROUP BY e.id, e.first_name, e.last_name, e.employee_code, e.designation, d.name
          ORDER BY sum(a.overtime_minutes) DESC NULLS LAST, e.first_name`,
        values,
      );

      const data = rows.map((r) => ({
        ...r,
        name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        net_minutes: r.overtime_minutes - r.shortfall_minutes,
        overtime_hours: formatMinutes(r.overtime_minutes),
        shortfall_hours: formatMinutes(r.shortfall_minutes),
        worked_hours: formatMinutes(r.work_minutes),
        expected_hours: formatMinutes(r.expected_minutes),
        // What payroll will actually pay extra for, at the usual 2× rate.
        overtime_units: Math.round((r.overtime_minutes / 60) * 100) / 100,
      }));

      const totals = data.reduce(
        (acc, r) => ({
          overtime_minutes: acc.overtime_minutes + r.overtime_minutes,
          shortfall_minutes: acc.shortfall_minutes + r.shortfall_minutes,
          work_minutes: acc.work_minutes + r.work_minutes,
          expected_minutes: acc.expected_minutes + r.expected_minutes,
        }),
        { overtime_minutes: 0, shortfall_minutes: 0, work_minutes: 0, expected_minutes: 0 },
      );

      return {
        data,
        meta: {
          from,
          to,
          headcount: data.length,
          ...totals,
          overtime_hours: formatMinutes(totals.overtime_minutes),
          shortfall_hours: formatMinutes(totals.shortfall_minutes),
          utilisation: totals.expected_minutes
            ? Math.round((totals.work_minutes / totals.expected_minutes) * 1000) / 10
            : null,
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════ PAYROLL'S VIEW
  /**
   * The only thing payroll is allowed to know about attendance.
   *
   * It is an internal, service-to-service read: payroll never touches HR's
   * tables, and HR never learns what a day is worth in rupees.
   */
  app.get(
    '/internal/attendance/summary',
    {
      preHandler: [requireInternal()],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            org_id: { type: 'string', minLength: 1, maxLength: 64 },
            from: v.date,
            to: v.date,
            employee_ids: { type: 'string', maxLength: 20_000 },
          },
          required: ['org_id', 'from', 'to'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { org_id: orgId, from, to } = request.query;
      const employeeIds = request.query.employee_ids
        ? request.query.employee_ids.split(',').filter(Boolean)
        : null;

      const rows = await periodSummary(db, orgId, { from, to, employeeIds });

      return {
        data: rows.map((r) => ({
          ...r,
          // A half day is half a day's pay; saying so here keeps the rule in
          // one place rather than in every payroll formula.
          payable_days: r.days_present + r.days_half * 0.5 + r.days_leave,
          overtime_hours: Math.round((r.overtime_minutes / 60) * 100) / 100,
        })),
        meta: { from, to, org_id: orgId },
      };
    },
  );
}
