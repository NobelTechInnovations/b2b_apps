import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest, conflict, forbidden,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { ensureLeaveTypes, workingDays } from '../lib/setup.js';
import { applyApproval, balancesFor } from '../lib/leave.js';

export async function leaveRoutes(app) {
  const { db } = app;

  // ════════════════════════════════════════════════════════════ LEAVE TYPES
  app.get(
    '/hr/leave-types',
    { preHandler: [app.loadContext, requirePermission('hr.leave.view')] },
    async (request) => {
      await ensureLeaveTypes(db, request.ctx.orgId);
      const rows = await db.rows(
        `SELECT * FROM leave_types WHERE org_id = $1 AND archived_at IS NULL ORDER BY position, name`,
        [request.ctx.orgId],
      );
      return { data: rows };
    },
  );

  /**
   * The workspace's leave policy: each type, how many days a year it gives,
   * whether it is paid and carries forward. Changing the days can also update
   * this year's balances — for everyone still on the policy's old number, so a
   * balance HR adjusted for one person by hand is left alone.
   */
  const COLOURS = ['slate', 'rose', 'emerald', 'amber', 'blue', 'violet', 'cyan', 'orange', 'pink', 'teal', 'indigo', 'lime'];
  const typeBody = {
    name: v.text(60, 1),
    code: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]{0,7}$' },
    days_per_year: { type: 'number', minimum: 0, maximum: 365, multipleOf: 0.5 },
    is_paid: v.bool,
    carry_forward: v.bool,
    requires_approval: v.bool,
    colour: v.enum(COLOURS),
  };
  const typeParams = { params: params({ leaveTypeId: v.id('lvt') }) };
  const codeTaken = (error) => {
    if (error.name === 'UniqueViolation') throw conflict('Another leave type already uses that short code.');
    throw error;
  };
  const year = () => new Date().getFullYear();

  app.post('/hr/leave-types', {
    preHandler: [app.loadContext, requirePermission('hr.leave.manage')],
    schema: { body: body(typeBody, ['name']) },
  }, async (request, reply) => {
    const { orgId } = request.ctx;
    const b = request.body;
    await ensureLeaveTypes(db, orgId);
    const initials = b.name.trim().split(/\s+/).map((w) => w[0]).join('').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
    const code = (b.code ?? (initials || 'LV')).toUpperCase();
    const row = await db.transaction(async (tx) => {
      const created = await tx.one(
        `INSERT INTO leave_types (id, org_id, name, code, days_per_year, is_paid, carry_forward, requires_approval, colour, position)
         VALUES ($1,$2,$3,$4,COALESCE($5,0),COALESCE($6,true),COALESCE($7,false),COALESCE($8,true),COALESCE($9,'slate'),
                 (SELECT COALESCE(max(position) + 1, 0) FROM leave_types WHERE org_id = $2))
         RETURNING *`,
        [id('lvt'), orgId, b.name.trim(), code, b.days_per_year ?? null, b.is_paid ?? null, b.carry_forward ?? null,
          b.requires_approval ?? null, b.colour ?? null],
      );
      // Everyone on the team starts this year with the new entitlement.
      await tx.query(
        `INSERT INTO leave_balances (org_id, employee_id, leave_type_id, year, entitled)
         SELECT $1, e.id, $2, $3, $4 FROM employees e
          WHERE e.org_id = $1 AND e.archived_at IS NULL AND e.status <> 'exited'
         ON CONFLICT DO NOTHING`,
        [orgId, created.id, year(), created.days_per_year],
      );
      return created;
    }).catch(codeTaken);
    return reply.status(201).send({ data: row });
  });

  app.patch('/hr/leave-types/:leaveTypeId', {
    preHandler: [app.loadContext, requirePermission('hr.leave.manage')],
    schema: { ...typeParams, body: body({ ...typeBody, update_balances: v.bool }) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const b = request.body;
    const result = await db.transaction(async (tx) => {
      const old = await tx.one(`SELECT * FROM leave_types WHERE org_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`, [orgId, request.params.leaveTypeId]);
      if (!old) throw notFound('Leave type');
      const row = await tx.one(
        `UPDATE leave_types SET name = COALESCE($3, name), code = COALESCE($4, code), days_per_year = COALESCE($5, days_per_year),
                is_paid = COALESCE($6, is_paid), carry_forward = COALESCE($7, carry_forward),
                requires_approval = COALESCE($8, requires_approval), colour = COALESCE($9, colour)
          WHERE org_id = $1 AND id = $2 RETURNING *`,
        [orgId, old.id, b.name?.trim() ?? null, b.code?.toUpperCase() ?? null, b.days_per_year ?? null, b.is_paid ?? null,
          b.carry_forward ?? null, b.requires_approval ?? null, b.colour ?? null],
      );
      let balancesUpdated = 0;
      if (b.update_balances !== false && Number(row.days_per_year) !== Number(old.days_per_year)) {
        const updated = await tx.rows(
          `UPDATE leave_balances lb SET entitled = $4, updated_at = now()
             FROM employees e
            WHERE lb.org_id = $1 AND lb.leave_type_id = $2 AND lb.year = $3 AND lb.entitled = $5
              AND e.id = lb.employee_id AND e.archived_at IS NULL AND e.status <> 'exited'
           RETURNING lb.employee_id`,
          [orgId, old.id, year(), row.days_per_year, old.days_per_year],
        );
        balancesUpdated = updated.length;
      }
      return { ...row, balances_updated: balancesUpdated };
    }).catch(codeTaken);
    return { data: result };
  });

  // Retiring a type hides it from new requests; past requests and balances stay.
  app.delete('/hr/leave-types/:leaveTypeId', {
    preHandler: [app.loadContext, requirePermission('hr.leave.manage')],
    schema: typeParams,
  }, async (request) => {
    const { orgId } = request.ctx;
    const left = await db.one(`SELECT count(*)::int AS n FROM leave_types WHERE org_id = $1 AND archived_at IS NULL`, [orgId]);
    if (left.n <= 1) throw badRequest('Keep at least one leave type.');
    const row = await db.one(
      `UPDATE leave_types SET archived_at = now() WHERE org_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id`,
      [orgId, request.params.leaveTypeId],
    );
    if (!row) throw notFound('Leave type');
    return { data: { archived: true } };
  });

  // ═══════════════════════════════════════════════════════════════ REQUESTS
  app.get(
    '/hr/leave',
    {
      preHandler: [app.loadContext, requirePermission('hr.leave.view')],
      schema: {
        querystring: query({
          status: v.enum(['pending', 'approved', 'rejected', 'cancelled']),
          employee_id: v.id('emp'),
          leave_type_id: v.id('lvt'),
          upcoming: { type: 'boolean' },
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'start_date'] });
      const qs = request.query;

      const where = ['lr.org_id = $1'];
      const values = [orgId];

      if (qs.status) { values.push(qs.status); where.push(`lr.status = $${values.length}`); }
      if (qs.employee_id) { values.push(qs.employee_id); where.push(`lr.employee_id = $${values.length}`); }
      if (qs.leave_type_id) { values.push(qs.leave_type_id); where.push(`lr.leave_type_id = $${values.length}`); }
      if (qs.upcoming) where.push(`lr.end_date >= current_date`);
      if (qs.q) {
        values.push(`%${qs.q}%`);
        where.push(`(e.first_name ILIKE $${values.length} OR e.last_name ILIKE $${values.length}
                     OR lr.reason ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');
      const join = `FROM leave_requests lr
                    JOIN employees e ON e.id = lr.employee_id
                    JOIN leave_types lt ON lt.id = lr.leave_type_id`;

      const [rows, total, counts] = await Promise.all([
        db.rows(
          `SELECT lr.*, e.first_name, e.last_name, e.employee_code, e.designation,
                  lt.name AS leave_type_name, lt.colour, lt.is_paid
             ${join} WHERE ${clause}
            ORDER BY lr.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n ${join} WHERE ${clause}`, values),
        db.one(
          `SELECT
             count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'approved'
               AND current_date BETWEEN start_date AND end_date)::int AS on_leave_today,
             count(*) FILTER (WHERE status = 'approved' AND start_date > current_date)::int AS upcoming
           FROM leave_requests WHERE org_id = $1`,
          [orgId],
        ),
      ]);

      return {
        data: rows.map((r) => ({
          ...r,
          employee_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        })),
        meta: { ...page.meta(total.n), counts },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════ REQUEST
  app.post(
    '/hr/leave',
    {
      preHandler: [app.loadContext, requirePermission('hr.leave.create')],
      schema: {
        body: body(
          {
            employee_id: v.id('emp'),
            leave_type_id: v.id('lvt'),
            start_date: v.date,
            end_date: v.date,
            half_day: { type: 'boolean' },
            reason: v.text(500),
          },
          ['employee_id', 'leave_type_id', 'start_date', 'end_date'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      const days = workingDays(b.start_date, b.end_date, b.half_day);
      if (days <= 0) {
        throw badRequest(
          'That range contains no working days. Check the dates — weekends are not counted.',
        );
      }

      const [employee, type] = await Promise.all([
        db.one(`SELECT * FROM employees WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
          [b.employee_id, orgId]),
        db.one(`SELECT * FROM leave_types WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
          [b.leave_type_id, orgId]),
      ]);

      if (!employee) throw notFound('Employee');
      if (!type) throw notFound('Leave type');
      if (employee.status === 'exited') {
        throw badRequest('This person has left the organisation.');
      }

      // Two overlapping requests for the same person is always a mistake.
      const overlap = await db.one(
        `SELECT lr.id, lr.start_date, lr.end_date, lr.status
           FROM leave_requests lr
          WHERE lr.org_id = $1 AND lr.employee_id = $2
            AND lr.status IN ('pending','approved')
            AND lr.start_date <= $4::date AND lr.end_date >= $3::date
          LIMIT 1`,
        [orgId, b.employee_id, b.start_date, b.end_date],
      );
      if (overlap) {
        throw conflict(
          `This overlaps an existing ${overlap.status} request from ${overlap.start_date} to ${overlap.end_date}.`,
          { conflicting_request_id: overlap.id },
        );
      }

      const year = new Date(b.start_date).getFullYear();

      const balance = await db.one(
        `SELECT entitled, carried, used FROM leave_balances
          WHERE org_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND year = $4`,
        [orgId, b.employee_id, b.leave_type_id, year],
      );

      const available = balance
        ? Number(balance.entitled) + Number(balance.carried) - Number(balance.used)
        : Number(type.days_per_year);

      // Unpaid leave has no balance to exhaust.
      if (type.is_paid && days > available) {
        throw badRequest(
          `Only ${available} day${available === 1 ? '' : 's'} of ${type.name} remain, but this request is for ${days}.`,
          { available, requested: days },
        );
      }

      const created = await db.transaction(async (tx) => {
        const row = await tx.one(
          `INSERT INTO leave_requests
             (id, org_id, employee_id, leave_type_id, start_date, end_date, days,
              half_day, reason, status, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                   CASE WHEN $10 THEN 'pending' ELSE 'approved' END, $11)
           RETURNING *`,
          [
            id('lvr'), orgId, b.employee_id, b.leave_type_id, b.start_date, b.end_date,
            days, b.half_day ?? false, b.reason ?? null, type.requires_approval, userId,
          ],
        );

        // Auto-approved types deduct immediately.
        if (row.status === 'approved') {
          await applyApproval(tx, { orgId, request: row, type, userId });
        }

        tx.emit({
          type: EVENTS.LEAVE_REQUESTED,
          org_id: orgId,
          actor_id: userId,
          data: {
            leave_request_id: row.id,
            employee_id: employee.id,
            employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
            leave_type: type.name,
            start_date: row.start_date,
            end_date: row.end_date,
            days: row.days,
            status: row.status,
          },
        });

        return row;
      });

      return reply.status(201).send({
        data: { ...created, available_before: available, available_after: available - days },
      });
    },
  );

  // ═══════════════════════════════════════════════════════════════ DECIDE
  app.post(
    '/hr/leave/:requestId/decide',
    {
      preHandler: [app.loadContext, requirePermission('hr.leave.approve')],
      schema: {
        params: params({ requestId: v.id('lvr') }),
        body: body({ decision: v.enum(['approved', 'rejected']), note: v.text(500) }, ['decision']),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      const leaveRequest = await db.one(
        `SELECT lr.*, lt.name AS leave_type_name, lt.is_paid,
                e.first_name, e.last_name, e.user_id AS employee_user_id
           FROM leave_requests lr
           JOIN leave_types lt ON lt.id = lr.leave_type_id
           JOIN employees e ON e.id = lr.employee_id
          WHERE lr.id = $1 AND lr.org_id = $2`,
        [request.params.requestId, orgId],
      );
      if (!leaveRequest) throw notFound('Leave request');
      if (leaveRequest.status !== 'pending') {
        throw badRequest(`This request has already been ${leaveRequest.status}.`);
      }
      // Nobody decides their own leave. Recording someone else's leave and
      // approving it is ordinary HR work, so it is the *subject* of the
      // request that matters here, not who typed it in.
      if (leaveRequest.employee_user_id === userId) {
        throw forbidden('You cannot decide your own leave. Ask another approver.', { code: 'self_approval' });
      }

      const approved = request.body.decision === 'approved';

      const updated = await db.transaction(async (tx) => {
        const row = await tx.one(
          `UPDATE leave_requests
              SET status = $3, approver_id = $4, decided_at = now(), decision_note = $5
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [leaveRequest.id, orgId, request.body.decision, userId, request.body.note ?? null],
        );

        if (approved) {
          await applyApproval(tx, {
            orgId,
            request: row,
            type: { is_paid: leaveRequest.is_paid },
            userId,
          });

        }

        // Both outcomes are news to the person who asked.
        tx.emit({
          type: approved ? EVENTS.LEAVE_APPROVED : EVENTS.LEAVE_REJECTED,
          org_id: orgId,
          actor_id: userId,
          data: {
            leave_request_id: row.id,
            employee_id: row.employee_id,
            employee_user_id: leaveRequest.employee_user_id,
            requested_by: leaveRequest.requested_by,
            employee_name: [leaveRequest.first_name, leaveRequest.last_name].filter(Boolean).join(' '),
            leave_type: leaveRequest.leave_type_name,
            start_date: row.start_date,
            end_date: row.end_date,
            days: row.days,
            note: row.decision_note,
          },
        });

        return row;
      });

      return { data: updated };
    },
  );

  // ═══════════════════════════════════════════════════════════════ CANCEL
  app.post(
    '/hr/leave/:requestId/cancel',
    {
      preHandler: [app.loadContext, requirePermission('hr.leave.create')],
      schema: { params: params({ requestId: v.id('lvr') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const leaveRequest = await db.one(
        `SELECT lr.*, lt.is_paid FROM leave_requests lr
           JOIN leave_types lt ON lt.id = lr.leave_type_id
          WHERE lr.id = $1 AND lr.org_id = $2`,
        [request.params.requestId, orgId],
      );
      if (!leaveRequest) throw notFound('Leave request');
      if (!['pending', 'approved'].includes(leaveRequest.status)) {
        throw badRequest(`A ${leaveRequest.status} request cannot be cancelled.`);
      }

      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE leave_requests SET status = 'cancelled', decided_at = now()
            WHERE id = $1 AND org_id = $2`,
          [leaveRequest.id, orgId],
        );

        // Give the days back and clear the attendance marks.
        if (leaveRequest.status === 'approved' && leaveRequest.is_paid) {
          await tx.query(
            `UPDATE leave_balances SET used = GREATEST(used - $5, 0), updated_at = now()
              WHERE org_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND year = $4`,
            [
              orgId, leaveRequest.employee_id, leaveRequest.leave_type_id,
              new Date(leaveRequest.start_date).getFullYear(), leaveRequest.days,
            ],
          );
        }

        if (leaveRequest.status === 'approved') {
          await tx.query(
            `DELETE FROM attendance
              WHERE org_id = $1 AND employee_id = $2 AND status = 'on_leave'
                AND on_date BETWEEN $3 AND $4`,
            [orgId, leaveRequest.employee_id, leaveRequest.start_date, leaveRequest.end_date],
          );
        }
      });

      return { data: { cancelled: true } };
    },
  );

  // ═══════════════════════════════════════════════════════════════ BALANCES
  app.get(
    '/hr/leave-balances/:employeeId',
    {
      preHandler: [app.loadContext, requirePermission('hr.leave.view')],
      schema: { params: params({ employeeId: v.id('emp') }) },
    },
    async (request) => {
      const year = new Date().getFullYear();
      const rows = await balancesFor(db, {
        orgId: request.ctx.orgId,
        employeeId: request.params.employeeId,
        year,
      });

      return { data: rows, meta: { year } };
    },
  );
}
