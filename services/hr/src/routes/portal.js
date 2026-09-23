import { id } from '@nexus/db-kit';
import {
  requirePermission, requireInternal, body, params, query, validate as v,
  notFound, badRequest, forbidden,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { shiftForEmployee, periodSummary, ensureDefaultShift } from '../lib/shifts.js';
import { balancesFor, checkLeaveRequest, applyApproval } from '../lib/leave.js';
import { formatMinutes } from '../lib/time.js';
import { toISODate } from '../lib/setup.js';

/**
 * The employee portal.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * The single rule that makes this safe: every route here resolves the person
 * from `request.ctx.userId` and NOTHING else. No route takes an employee id,
 * so there is no id to tamper with. A portal user who guesses a colleague's
 * employee id has nowhere to put it.
 *
 * The permissions these routes require (`hr.self.*`) are held only by the
 * `employee` role, which grants `*.self.*` and denies everything else. A
 * manager reading their own payslip uses these same routes; a manager reading
 * somebody else's uses the ordinary HR routes and the ordinary HR permissions.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Resolve the signed-in user to their employee record, or refuse. */
async function me(db, request) {
  const { orgId, userId } = request.ctx;

  const employee = await db.one(
    `SELECT e.*, d.name AS department_name,
            m.first_name AS manager_first_name, m.last_name AS manager_last_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN employees m ON m.id = e.manager_id
      WHERE e.org_id = $1 AND e.user_id = $2 AND e.archived_at IS NULL`,
    [orgId, userId],
  );

  if (!employee) {
    throw forbidden('Your login is not linked to an employee record in this workspace.', {
      code: 'no_employee_record',
    });
  }

  return employee;
}

export async function portalRoutes(app) {
  const { db } = app;

  // ══════════════════════════════════════════════════════════════════ ME
  app.get(
    '/hr/me',
    { preHandler: [app.loadContext, requirePermission('hr.self.view')] },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);
      await ensureDefaultShift(db, orgId);

      const today = toISODate(new Date());
      const shift = await shiftForEmployee(db, orgId, employee.id, today);

      const [todayRow, balances, pendingDocs, openReview] = await Promise.all([
        db.one(
          `SELECT * FROM attendance WHERE org_id = $1 AND employee_id = $2 AND on_date = current_date`,
          [orgId, employee.id],
        ),
        balancesFor(db, { orgId, employeeId: employee.id, year: new Date().getFullYear() }),
        db.one(
          `SELECT count(*)::int AS n FROM employee_documents
            WHERE org_id = $1 AND employee_id = $2 AND status = 'issued'
              AND requires_acknowledgement AND acknowledged_at IS NULL
              AND visible_to_employee`,
          [orgId, employee.id],
        ),
        db.one(
          `SELECT r.id, r.status, c.name AS cycle_name, c.self_review_due,
                  c.status AS cycle_status
             FROM reviews r JOIN review_cycles c ON c.id = r.cycle_id
            WHERE r.org_id = $1 AND r.employee_id = $2
              AND c.status IN ('self_review','manager_review','shared')
            ORDER BY c.period_end DESC LIMIT 1`,
          [orgId, employee.id],
        ),
      ]);

      // This month's time, so the first screen answers "am I on track".
      const monthStart = new Date();
      monthStart.setDate(1);
      const [summary] = await periodSummary(db, orgId, {
        from: toISODate(monthStart),
        to: today,
        employeeIds: [employee.id],
      });

      return {
        data: {
          employee: {
            id: employee.id,
            name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
            employee_code: employee.employee_code,
            designation: employee.designation,
            department_name: employee.department_name,
            employment_type: employee.employment_type,
            status: employee.status,
            joined_on: employee.joined_on,
            email: employee.email,
            phone: employee.phone,
            work_location: employee.work_location,
            manager_name: employee.manager_first_name
              ? [employee.manager_first_name, employee.manager_last_name].filter(Boolean).join(' ')
              : null,
          },
          shift: shift && {
            name: shift.name,
            window: `${String(shift.starts_at).slice(0, 5)}–${String(shift.ends_at).slice(0, 5)}`,
            break_minutes: shift.break_minutes,
            working_days: shift.working_days,
          },
          today: todayRow && {
            status: todayRow.status,
            check_in_at: todayRow.check_in_at,
            check_out_at: todayRow.check_out_at,
            worked: formatMinutes(todayRow.work_minutes),
          },
          this_month: summary
            ? {
                days_present: summary.days_present,
                days_absent: summary.days_absent,
                days_leave: summary.days_leave,
                overtime_hours: formatMinutes(summary.overtime_minutes),
                worked_hours: formatMinutes(summary.work_minutes),
                expected_hours: formatMinutes(summary.expected_minutes),
              }
            : null,
          leave_balances: balances,
          documents_to_acknowledge: pendingDocs.n,
          open_review: openReview,
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════ ATTENDANCE
  app.get(
    '/hr/me/attendance',
    {
      preHandler: [app.loadContext, requirePermission('hr.self.attendance')],
      schema: { querystring: query({ from: v.date, to: v.date }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const today = new Date();
      const from = request.query.from
        ?? toISODate(new Date(today.getFullYear(), today.getMonth(), 1));
      const to = request.query.to ?? toISODate(today);

      const rows = await db.rows(
        `SELECT a.on_date, a.status, a.check_in_at, a.check_out_at, a.work_minutes,
                a.expected_minutes, a.overtime_minutes, a.shortfall_minutes,
                a.late_minutes, a.early_exit_minutes, a.source, s.name AS shift_name
           FROM attendance a
           LEFT JOIN shifts s ON s.id = a.shift_id
          WHERE a.org_id = $1 AND a.employee_id = $2
            AND a.on_date BETWEEN $3::date AND $4::date
          ORDER BY a.on_date DESC`,
        [orgId, employee.id, from, to],
      );

      const [summary] = await periodSummary(db, orgId, { from, to, employeeIds: [employee.id] });

      return {
        data: rows.map((r) => ({
          ...r,
          worked: formatMinutes(r.work_minutes),
          overtime: r.overtime_minutes ? formatMinutes(r.overtime_minutes) : null,
          shortfall: r.shortfall_minutes ? formatMinutes(r.shortfall_minutes) : null,
        })),
        meta: {
          from,
          to,
          ...(summary ?? {}),
          overtime_hours: formatMinutes(summary?.overtime_minutes ?? 0),
          worked_hours: formatMinutes(summary?.work_minutes ?? 0),
        },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════════ LEAVE
  app.get(
    '/hr/me/leave',
    { preHandler: [app.loadContext, requirePermission('hr.self.leave')] },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const [requests, balances] = await Promise.all([
        db.rows(
          `SELECT lr.*, lt.name AS leave_type_name, lt.code AS leave_type_code, lt.colour
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
            WHERE lr.org_id = $1 AND lr.employee_id = $2
            ORDER BY lr.start_date DESC LIMIT 50`,
          [orgId, employee.id],
        ),
        balancesFor(db, { orgId, employeeId: employee.id, year: new Date().getFullYear() }),
      ]);

      // Days already spoken for but not yet decided — the portal shows this
      // next to the balance so nobody applies twice for the same week.
      const pending = requests
        .filter((r) => r.status === 'pending')
        .reduce((sum, r) => sum + Number(r.days), 0);

      return {
        data: { requests, balances, leave_types: balances },
        meta: { pending_days: pending },
      };
    },
  );

  /**
   * Applying for leave.
   *
   * The employee id is taken from the session, never from the body — which is
   * why this is a separate route from the HR one rather than the same route
   * with a looser permission.
   */
  app.post(
    '/hr/me/leave',
    {
      preHandler: [app.loadContext, requirePermission('hr.self.leave')],
      schema: {
        body: body(
          {
            leave_type_id: v.id('lvt'),
            start_date: v.date,
            end_date: v.date,
            half_day: v.bool,
            reason: v.text(500),
          },
          ['leave_type_id', 'start_date', 'end_date'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const employee = await me(db, request);
      const b = request.body;

      // The same check HR's own screen runs. An employee applying for
      // themselves must not get past a rule HR would have enforced.
      const { type, days } = await checkLeaveRequest(db, {
        orgId,
        employeeId: employee.id,
        leaveTypeId: b.leave_type_id,
        startDate: b.start_date,
        endDate: b.end_date,
        halfDay: b.half_day,
      });

      const row = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO leave_requests
             (id, org_id, employee_id, leave_type_id, start_date, end_date, days,
              half_day, reason, status, requested_by)
           VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,
                   CASE WHEN $10 THEN 'pending' ELSE 'approved' END, $11)
           RETURNING *`,
          [
            id('lvr'), orgId, employee.id, type.id, b.start_date, b.end_date,
            days, b.half_day ?? false, b.reason ?? null, type.requires_approval, userId,
          ],
        );

        // A type that needs no approval is settled on the spot, exactly as it
        // would be if HR had entered it.
        if (created.status === 'approved') {
          await applyApproval(tx, { orgId, request: created, type, userId });
        }

        tx.emit({
          type: EVENTS.LEAVE_REQUESTED,
          org_id: orgId,
          actor_id: userId,
          data: {
            leave_request_id: created.id,
            employee_id: employee.id,
            employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
            leave_type: type.name,
            start_date: created.start_date,
            end_date: created.end_date,
            days,
            via: 'portal',
          },
        });

        return created;
      });

      return reply.status(201).send({ data: { ...row, leave_type_name: type.name } });
    },
  );

  /** Withdrawing a request that has not been decided yet. */
  app.delete(
    '/hr/me/leave/:requestId',
    {
      preHandler: [app.loadContext, requirePermission('hr.self.leave')],
      schema: { params: params({ requestId: v.id('lvr') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const existing = await db.one(
        `SELECT * FROM leave_requests
          WHERE id = $1 AND org_id = $2 AND employee_id = $3`,
        [request.params.requestId, orgId, employee.id],
      );
      if (!existing) throw notFound('Leave request');
      if (existing.status !== 'pending') {
        throw badRequest(`That request has already been ${existing.status}. Ask HR to change it.`);
      }

      // A pending request never deducted a balance, so withdrawing one is
      // just a status change — there is nothing to give back.
      await db.query(
        `UPDATE leave_requests SET status = 'cancelled' WHERE id = $1 AND org_id = $2`,
        [existing.id, orgId],
      );

      return { data: { cancelled: true } };
    },
  );

  // ═══════════════════════════════════════════════════════════════ DOCUMENTS
  app.get(
    '/hr/me/documents',
    { preHandler: [app.loadContext, requirePermission('hr.self.documents')] },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const rows = await db.rows(
        `SELECT id, kind, title, reference, status, issued_on, valid_until,
                requires_acknowledgement, acknowledged_at, file_name,
                (body IS NOT NULL) AS has_letter
           FROM employee_documents
          WHERE org_id = $1 AND employee_id = $2
            AND visible_to_employee AND status IN ('issued','acknowledged')
          ORDER BY COALESCE(issued_on, created_at::date) DESC, created_at DESC`,
        [orgId, employee.id],
      );

      return {
        data: rows,
        meta: {
          total: rows.length,
          awaiting_acknowledgement: rows.filter(
            (r) => r.requires_acknowledgement && !r.acknowledged_at,
          ).length,
        },
      };
    },
  );

  app.get(
    '/hr/me/documents/:documentId',
    {
      preHandler: [app.loadContext, requirePermission('hr.self.documents')],
      schema: { params: params({ documentId: v.id('edo') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const document = await db.one(
        `SELECT * FROM employee_documents
          WHERE id = $1 AND org_id = $2 AND employee_id = $3
            AND visible_to_employee AND status IN ('issued','acknowledged')`,
        [request.params.documentId, orgId, employee.id],
      );
      if (!document) throw notFound('Document');

      return { data: document };
    },
  );

  app.post(
    '/hr/me/documents/:documentId/acknowledge',
    {
      preHandler: [app.loadContext, requirePermission('hr.self.documents')],
      schema: {
        params: params({ documentId: v.id('edo') }),
        body: body({ note: v.text(500) }, []),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const updated = await db.one(
        `UPDATE employee_documents
            SET status = 'acknowledged', acknowledged_at = now(), acknowledgement_ip = $4
          WHERE id = $1 AND org_id = $2 AND employee_id = $3
            AND status = 'issued' AND visible_to_employee
          RETURNING id, title, acknowledged_at`,
        [request.params.documentId, orgId, employee.id, request.ip ?? null],
      );
      if (!updated) throw notFound('Document');

      return { data: updated };
    },
  );

  // ═════════════════════════════════════════════════════════════ PERFORMANCE
  app.get(
    '/hr/me/performance',
    { preHandler: [app.loadContext, requirePermission('hr.self.performance')] },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const [reviews, goals] = await Promise.all([
        db.rows(
          `SELECT r.id, r.status, r.self_scores, r.self_comments,
                  r.overall_rating, r.recommendation, r.acknowledged_at,
                  -- A manager's notes are the employee's to read only once the
                  -- cycle has been shared with them.
                  CASE WHEN r.status IN ('shared','acknowledged') THEN r.manager_scores ELSE NULL END AS manager_scores,
                  CASE WHEN r.status IN ('shared','acknowledged') THEN r.manager_comments ELSE NULL END AS manager_comments,
                  CASE WHEN r.status IN ('shared','acknowledged') THEN r.strengths ELSE NULL END AS strengths,
                  CASE WHEN r.status IN ('shared','acknowledged') THEN r.improvements ELSE NULL END AS improvements,
                  c.id AS cycle_id, c.name AS cycle_name, c.period_start, c.period_end,
                  c.status AS cycle_status, c.competencies, c.rating_scale,
                  c.self_review_due, c.instructions
             FROM reviews r JOIN review_cycles c ON c.id = r.cycle_id
            WHERE r.org_id = $1 AND r.employee_id = $2 AND c.archived_at IS NULL
            ORDER BY c.period_end DESC`,
          [orgId, employee.id],
        ),
        db.rows(
          `SELECT * FROM goals
            WHERE org_id = $1 AND employee_id = $2 AND status <> 'draft'
            ORDER BY status, due_on NULLS LAST, created_at DESC`,
          [orgId, employee.id],
        ),
      ]);

      return { data: { reviews, goals } };
    },
  );

  /** The employee's half of a review. Only while the cycle is collecting them. */
  app.post(
    '/hr/me/performance/:reviewId/self',
    {
      preHandler: [app.loadContext, requirePermission('hr.self.performance')],
      schema: {
        params: params({ reviewId: v.id('rev') }),
        body: body(
          {
            scores: { type: 'object', additionalProperties: true },
            comments: v.text(4000),
            submit: v.bool,
          },
          [],
        ),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const review = await db.one(
        `SELECT r.*, c.status AS cycle_status FROM reviews r
           JOIN review_cycles c ON c.id = r.cycle_id
          WHERE r.id = $1 AND r.org_id = $2 AND r.employee_id = $3`,
        [request.params.reviewId, orgId, employee.id],
      );
      if (!review) throw notFound('Review');
      if (review.cycle_status !== 'self_review') {
        throw badRequest(
          review.cycle_status === 'draft'
            ? 'This review has not opened yet.'
            : 'Self-reviews for this cycle have closed.',
        );
      }
      if (review.self_submitted_at) throw badRequest('You have already submitted this self-review.');

      const submit = request.body.submit ?? false;

      const updated = await db.one(
        `UPDATE reviews
            SET self_scores = COALESCE($4::jsonb, self_scores),
                self_comments = COALESCE($5, self_comments),
                status = CASE WHEN $6 THEN 'self_submitted' ELSE status END,
                self_submitted_at = CASE WHEN $6 THEN now() ELSE self_submitted_at END
          WHERE id = $1 AND org_id = $2 AND employee_id = $3
          RETURNING *`,
        [
          review.id, orgId, employee.id,
          request.body.scores ? JSON.stringify(request.body.scores) : null,
          request.body.comments ?? null,
          submit,
        ],
      );

      return { data: updated };
    },
  );

  /** Reading a shared review is one thing; signing it off is another. */
  app.post(
    '/hr/me/performance/:reviewId/acknowledge',
    {
      preHandler: [app.loadContext, requirePermission('hr.self.performance')],
      schema: {
        params: params({ reviewId: v.id('rev') }),
        body: body({ note: v.text(2000) }, []),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);

      const updated = await db.one(
        `UPDATE reviews
            SET status = 'acknowledged', acknowledged_at = now(), acknowledgement = $4
          WHERE id = $1 AND org_id = $2 AND employee_id = $3 AND status = 'shared'
          RETURNING id, acknowledged_at, acknowledgement`,
        [request.params.reviewId, orgId, employee.id, request.body.note ?? null],
      );
      if (!updated) throw notFound('A shared review');

      return { data: updated };
    },
  );

  /** Updating progress on a goal they own. */
  app.patch(
    '/hr/me/goals/:goalId',
    {
      preHandler: [app.loadContext, requirePermission('hr.self.performance')],
      schema: {
        params: params({ goalId: v.id('gol') }),
        body: body({ progress: v.int(0, 100), current_value: v.money, note: v.text(1000) }, []),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await me(db, request);
      const b = request.body;

      const fields = ['progress', 'current_value'].filter((f) => b[f] !== undefined);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 4}`).join(', ');
      const updated = await db.one(
        `UPDATE goals SET ${sets}
          WHERE id = $1 AND org_id = $2 AND employee_id = $3 AND status = 'active'
          RETURNING *`,
        [request.params.goalId, orgId, employee.id, ...fields.map((f) => b[f])],
      );
      if (!updated) throw notFound('An active goal');

      return { data: updated };
    },
  );

  // ══════════════════════════════════════════════════════════ ADMINISTRATION
  /** Who has portal access, who has been invited, and who has none. */
  app.get(
    '/hr/portal/access',
    { preHandler: [app.loadContext, requirePermission('hr.employees.view')] },
    async (request) => {
      const { orgId } = request.ctx;

      const rows = await db.rows(
        `SELECT e.id, e.first_name, e.last_name, e.employee_code, e.designation,
                e.email, e.personal_email, e.portal_status, e.portal_invited_at,
                e.portal_linked_at, (e.user_id IS NOT NULL) AS linked,
                d.name AS department_name
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
          WHERE e.org_id = $1 AND e.archived_at IS NULL AND e.status <> 'exited'
          ORDER BY e.first_name, e.last_name`,
        [orgId],
      );

      const counts = rows.reduce(
        (acc, row) => { acc[row.portal_status] = (acc[row.portal_status] ?? 0) + 1; return acc; },
        { none: 0, invited: 0, active: 0, suspended: 0 },
      );

      return {
        data: rows.map((r) => ({
          ...r,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
          // Nobody can be invited without somewhere to send it.
          invitable: Boolean(r.email || r.personal_email),
        })),
        meta: { total: rows.length, counts },
      };
    },
  );

  /**
   * Invite an employee to the portal.
   *
   * HR does not create logins. It asks tenancy to send the same invitation an
   * admin would send from the members screen, with the `employee` role
   * attached — one invitation mechanism, one acceptance path, one thing to
   * keep secure. HR learns it was accepted from the membership event.
   */
  app.post(
    '/hr/portal/invite',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.edit')],
      schema: {
        body: body(
          {
            employee_ids: { type: 'array', items: v.id('emp'), minItems: 1, maxItems: 200 },
            message: v.text(500),
          },
          ['employee_ids'],
        ),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      const role = await app.tenancy.employeeRole(orgId).catch((error) => {
        request.log.error({ err: error }, 'could not read roles from tenancy');
        return null;
      });
      if (!role) {
        throw badRequest('This workspace has no employee role to grant. Ask an owner to check Settings → Roles.');
      }

      const people = await db.rows(
        `SELECT id, first_name, last_name, email, personal_email, user_id, portal_status
           FROM employees
          WHERE org_id = $1 AND id = ANY($2::text[]) AND archived_at IS NULL`,
        [orgId, request.body.employee_ids],
      );
      if (!people.length) throw badRequest('None of those employees exist in this workspace.');

      const invited = [];
      const skipped = [];

      for (const person of people) {
        const name = [person.first_name, person.last_name].filter(Boolean).join(' ');
        const email = person.email ?? person.personal_email;

        if (person.user_id) { skipped.push({ name, reason: 'already has portal access' }); continue; }
        if (!email) { skipped.push({ name, reason: 'no email address on record' }); continue; }

        try {
          const invitation = await app.tenancy.invite(orgId, {
            email,
            roleIds: [role.id],
            title: 'Employee portal',
            message: request.body.message,
            userId,
          });

          await db.query(
            `UPDATE employees
                SET portal_status = 'invited', portal_invited_at = now()
              WHERE id = $1 AND org_id = $2`,
            [person.id, orgId],
          );

          invited.push({ name, email, invite_link: invitation.invite_link });
        } catch (error) {
          // One bad address must not abandon the rest of the batch.
          skipped.push({ name, reason: error.message ?? 'could not be invited' });
        }
      }

      return { data: { invited, skipped }, meta: { sent: invited.length, skipped: skipped.length } };
    },
  );

  /** Revoke portal access without touching the employment record. */
  app.post(
    '/hr/portal/revoke',
    {
      preHandler: [app.loadContext, requirePermission('hr.employees.edit')],
      schema: { body: body({ employee_id: v.id('emp') }, ['employee_id']) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const updated = await db.one(
        `UPDATE employees
            SET portal_status = 'suspended', user_id = NULL
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
          RETURNING id, first_name, last_name`,
        [request.body.employee_id, orgId],
      );
      if (!updated) throw notFound('Employee');

      // Their workspace membership is a separate thing, removed from Settings
      // → Members. This only breaks the link to the employee record.
      return {
        data: {
          revoked: true,
          note: 'Portal access removed. Their workspace membership is unchanged — remove that from Settings → Members if they have left.',
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════ PAYROLL'S LOOKUP
  /**
   * Which employee is this login? Payroll asks, so it can serve a payslip to
   * the person it belongs to without holding its own copy of the mapping.
   */
  app.get(
    '/internal/employees/by-user/:userId',
    {
      preHandler: [requireInternal()],
      schema: {
        params: params({ userId: { type: 'string', minLength: 1, maxLength: 64 } }),
        querystring: {
          type: 'object',
          properties: { org_id: { type: 'string', minLength: 1, maxLength: 64 } },
          required: ['org_id'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const row = await db.one(
        `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.designation,
                e.joined_on, d.name AS department_name
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
          WHERE e.org_id = $1 AND e.user_id = $2 AND e.archived_at IS NULL`,
        [request.query.org_id, request.params.userId],
      );

      if (!row) return { data: null };

      return {
        data: { ...row, name: [row.first_name, row.last_name].filter(Boolean).join(' ') },
      };
    },
  );
}
