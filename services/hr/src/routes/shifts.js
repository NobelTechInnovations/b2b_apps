import { id } from '@nexus/db-kit';
import {
  requirePermission, body, params, query, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';
import { shiftMinutes, formatMinutes, deriveDay, isWorkingDay } from '../lib/time.js';
import { ensureDefaultShift, shiftForEmployee, recomputeRange } from '../lib/shifts.js';
import { toISODate } from '../lib/setup.js';

const WEEKDAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const timeOfDay = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$' };
const weekdays = {
  type: 'array',
  items: { type: 'integer', minimum: 1, maximum: 7 },
  minItems: 1,
  maxItems: 7,
};

const decorate = (shift) => ({
  ...shift,
  starts_at: String(shift.starts_at).slice(0, 5),
  ends_at: String(shift.ends_at).slice(0, 5),
  paid_minutes: shiftMinutes(shift),
  paid_hours: formatMinutes(shiftMinutes(shift)),
  working_day_labels: (shift.working_days ?? []).map((d) => WEEKDAY_NAMES[d]),
});

export async function shiftRoutes(app) {
  const { db } = app;

  // ═════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/hr/shifts',
    { preHandler: [app.loadContext, requirePermission('hr.shifts.view')] },
    async (request) => {
      const { orgId } = request.ctx;
      await ensureDefaultShift(db, orgId);

      const rows = await db.rows(
        `SELECT s.*,
                (SELECT count(DISTINCT es.employee_id)::int
                   FROM employee_shifts es
                   JOIN employees e ON e.id = es.employee_id
                                   AND e.archived_at IS NULL AND e.status <> 'exited'
                  WHERE es.shift_id = s.id
                    AND es.effective_from <= current_date
                    AND (es.effective_to IS NULL OR es.effective_to >= current_date)) AS assigned_count
           FROM shifts s
          WHERE s.org_id = $1 AND s.archived_at IS NULL
          ORDER BY s.is_default DESC, s.starts_at, s.name`,
        [orgId],
      );

      // Anyone with no dated assignment falls to the default shift, so the
      // counts on screen add up to the headcount rather than to less.
      const unassigned = await db.one(
        `SELECT count(*)::int AS n FROM employees e
          WHERE e.org_id = $1 AND e.archived_at IS NULL AND e.status <> 'exited'
            AND NOT EXISTS (
              SELECT 1 FROM employee_shifts es
               WHERE es.employee_id = e.id
                 AND es.effective_from <= current_date
                 AND (es.effective_to IS NULL OR es.effective_to >= current_date))`,
        [orgId],
      );

      return {
        data: rows.map((row) => ({
          ...decorate(row),
          assigned_count: row.is_default ? row.assigned_count + unassigned.n : row.assigned_count,
          inherited_count: row.is_default ? unassigned.n : 0,
        })),
        meta: { total: rows.length, unassigned: unassigned.n },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════ CREATE
  app.post(
    '/hr/shifts',
    {
      preHandler: [app.loadContext, requirePermission('hr.shifts.manage')],
      schema: {
        body: body(
          {
            name: v.text(80, 1),
            code: v.text(20),
            starts_at: timeOfDay,
            ends_at: timeOfDay,
            break_minutes: v.int(0, 480),
            working_days: weekdays,
            grace_minutes: v.int(0, 120),
            half_day_minutes: v.int(0, 720),
            overtime_after_minutes: v.int(0, 480),
            is_default: v.bool,
          },
          ['name'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId } = request.ctx;
      const b = request.body;

      const clash = await db.one(
        `SELECT id FROM shifts WHERE org_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL`,
        [orgId, b.name.trim()],
      );
      if (clash) throw conflict('A shift with that name already exists.');

      const starts = b.starts_at ?? '09:00';
      const ends = b.ends_at ?? '18:00';
      // Crossing midnight is the definition of a night shift; deriving it here
      // means nobody has to remember to tick a box for it to be paid right.
      const isNight = ends <= starts;

      const shift = await db.transaction(async (tx) => {
        if (b.is_default) {
          await tx.query(
            `UPDATE shifts SET is_default = false WHERE org_id = $1 AND is_default`,
            [orgId],
          );
        }
        return tx.one(
          `INSERT INTO shifts
             (id, org_id, name, code, starts_at, ends_at, break_minutes, working_days,
              grace_minutes, half_day_minutes, overtime_after_minutes, is_night_shift, is_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            id('sft'), orgId, b.name.trim(), b.code ?? null, starts, ends,
            b.break_minutes ?? 60, b.working_days ?? [1, 2, 3, 4, 5],
            b.grace_minutes ?? 10, b.half_day_minutes ?? 240,
            b.overtime_after_minutes ?? 0, isNight, b.is_default ?? false,
          ],
        );
      });

      return reply.status(201).send({ data: { ...decorate(shift), assigned_count: 0 } });
    },
  );

  // ═══════════════════════════════════════════════════════════════ UPDATE
  app.patch(
    '/hr/shifts/:shiftId',
    {
      preHandler: [app.loadContext, requirePermission('hr.shifts.manage')],
      schema: {
        params: params({ shiftId: v.id('sft') }),
        body: body({
          name: v.text(80, 1), code: v.text(20), starts_at: timeOfDay, ends_at: timeOfDay,
          break_minutes: v.int(0, 480), working_days: weekdays, grace_minutes: v.int(0, 120),
          half_day_minutes: v.int(0, 720), overtime_after_minutes: v.int(0, 480), is_default: v.bool,
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const b = request.body;

      const current = await db.one(
        `SELECT * FROM shifts WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.shiftId, orgId],
      );
      if (!current) throw notFound('Shift');

      const fields = [
        'name', 'code', 'starts_at', 'ends_at', 'break_minutes', 'working_days',
        'grace_minutes', 'half_day_minutes', 'overtime_after_minutes', 'is_default',
      ].filter((f) => b[f] !== undefined);
      if (!fields.length) throw badRequest('Nothing to update.');

      const starts = b.starts_at ?? String(current.starts_at).slice(0, 5);
      const ends = b.ends_at ?? String(current.ends_at).slice(0, 5);

      const updated = await db.transaction(async (tx) => {
        if (b.is_default) {
          await tx.query(
            `UPDATE shifts SET is_default = false WHERE org_id = $1 AND is_default AND id <> $2`,
            [orgId, current.id],
          );
        } else if (b.is_default === false && current.is_default) {
          // A workspace with no default shift has nowhere to put new hires.
          throw badRequest('Make another shift the default before clearing this one.');
        }

        const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
        return tx.one(
          `UPDATE shifts SET ${sets}, is_night_shift = $${fields.length + 3}
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [current.id, orgId, ...fields.map((f) => b[f]), ends <= starts],
        );
      });

      // Hours changed, so every open day computed against the old hours is now
      // wrong. Rewrite the current month rather than leaving stale overtime.
      const from = new Date();
      from.setDate(1);
      const touched = await recomputeRange(db, orgId, {
        from: toISODate(from),
        to: toISODate(new Date()),
        shiftId: current.id,
      });

      return { data: decorate(updated), meta: { attendance_recomputed: touched } };
    },
  );

  // ══════════════════════════════════════════════════════════════ ARCHIVE
  app.delete(
    '/hr/shifts/:shiftId',
    {
      preHandler: [app.loadContext, requirePermission('hr.shifts.manage')],
      schema: { params: params({ shiftId: v.id('sft') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const shift = await db.one(
        `SELECT * FROM shifts WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.shiftId, orgId],
      );
      if (!shift) throw notFound('Shift');
      if (shift.is_default) throw badRequest('The default shift cannot be deleted.');

      const assigned = await db.one(
        `SELECT count(DISTINCT es.employee_id)::int AS n
           FROM employee_shifts es
           JOIN employees e ON e.id = es.employee_id AND e.archived_at IS NULL
          WHERE es.shift_id = $1
            AND (es.effective_to IS NULL OR es.effective_to >= current_date)`,
        [shift.id],
      );
      if (assigned.n > 0) {
        throw badRequest(
          `${assigned.n} ${assigned.n === 1 ? 'person is' : 'people are'} on this shift. Move them first.`,
        );
      }

      await db.query(`UPDATE shifts SET archived_at = now() WHERE id = $1 AND org_id = $2`, [shift.id, orgId]);
      return { data: { archived: true } };
    },
  );

  // ════════════════════════════════════════════════════════════ ASSIGNMENT
  /** Who is on which shift, with the dated history behind each answer. */
  app.get(
    '/hr/shifts/assignments',
    {
      preHandler: [app.loadContext, requirePermission('hr.shifts.view')],
      schema: { querystring: query({ shift_id: v.id('sft'), department_id: v.id('dep') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      await ensureDefaultShift(db, orgId);

      const values = [orgId];
      let filter = '';
      if (request.query.department_id) {
        values.push(request.query.department_id);
        filter += ` AND e.department_id = $${values.length}`;
      }

      const rows = await db.rows(
        `SELECT e.id AS employee_id, e.first_name, e.last_name, e.employee_code, e.designation,
                d.name AS department_name,
                cur.shift_id, cur.effective_from, cur.effective_to,
                s.name AS shift_name, s.starts_at, s.ends_at, s.break_minutes, s.working_days,
                def.id AS default_shift_id, def.name AS default_shift_name
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
           LEFT JOIN LATERAL (
             SELECT es.* FROM employee_shifts es
              WHERE es.employee_id = e.id
                AND es.effective_from <= current_date
                AND (es.effective_to IS NULL OR es.effective_to >= current_date)
              ORDER BY es.effective_from DESC LIMIT 1
           ) cur ON true
           LEFT JOIN shifts s ON s.id = cur.shift_id
           LEFT JOIN shifts def ON def.org_id = e.org_id AND def.is_default AND def.archived_at IS NULL
          WHERE e.org_id = $1 AND e.archived_at IS NULL AND e.status <> 'exited' ${filter}
          ORDER BY e.first_name, e.last_name`,
        values,
      );

      const data = rows
        .map((r) => ({
          employee_id: r.employee_id,
          name: [r.first_name, r.last_name].filter(Boolean).join(' '),
          employee_code: r.employee_code,
          designation: r.designation,
          department_name: r.department_name,
          shift_id: r.shift_id ?? r.default_shift_id,
          shift_name: r.shift_name ?? r.default_shift_name,
          inherited: !r.shift_id,
          effective_from: r.effective_from,
          effective_to: r.effective_to,
          window: r.starts_at ? `${String(r.starts_at).slice(0, 5)}–${String(r.ends_at).slice(0, 5)}` : null,
        }))
        .filter((r) => !request.query.shift_id || r.shift_id === request.query.shift_id);

      return { data, meta: { total: data.length } };
    },
  );

  /**
   * Assign a shift from a date forward.
   *
   * The previous assignment is closed the day before rather than deleted, so
   * last month's payslip still explains itself with last month's hours.
   */
  app.post(
    '/hr/shifts/:shiftId/assign',
    {
      preHandler: [app.loadContext, requirePermission('hr.shifts.manage')],
      schema: {
        params: params({ shiftId: v.id('sft') }),
        body: body(
          {
            employee_ids: { type: 'array', items: v.id('emp'), minItems: 1, maxItems: 500 },
            effective_from: v.date,
          },
          ['employee_ids'],
        ),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const from = request.body.effective_from ?? toISODate(new Date());

      const shift = await db.one(
        `SELECT * FROM shifts WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [request.params.shiftId, orgId],
      );
      if (!shift) throw notFound('Shift');

      const people = await db.rows(
        `SELECT id FROM employees
          WHERE org_id = $1 AND id = ANY($2::text[]) AND archived_at IS NULL`,
        [orgId, request.body.employee_ids],
      );
      if (!people.length) throw badRequest('None of those employees exist in this workspace.');

      await db.transaction(async (tx) => {
        for (const person of people) {
          // Close anything still open on or after the new start date.
          await tx.query(
            `UPDATE employee_shifts
                SET effective_to = ($3::date - 1)
              WHERE employee_id = $1 AND org_id = $2
                AND (effective_to IS NULL OR effective_to >= $3::date)
                AND effective_from < $3::date`,
            [person.id, orgId, from],
          );
          // A row that starts on or after the new date is superseded outright.
          await tx.query(
            `DELETE FROM employee_shifts
              WHERE employee_id = $1 AND org_id = $2 AND effective_from >= $3::date`,
            [person.id, orgId, from],
          );
          await tx.query(
            `INSERT INTO employee_shifts (id, org_id, employee_id, shift_id, effective_from)
             VALUES ($1,$2,$3,$4,$5::date)`,
            [id('esh'), orgId, person.id, shift.id, from],
          );
        }
      });

      const touched = await recomputeRange(db, orgId, {
        from,
        to: toISODate(new Date()),
        employeeIds: people.map((p) => p.id),
      });

      return {
        data: { assigned: people.length, shift_id: shift.id, effective_from: from },
        meta: { attendance_recomputed: touched },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════ ROSTER
  /**
   * The week ahead: who is expected in, when, and for how long. This is the
   * screen a supervisor uses to spot a day with nobody scheduled.
   */
  app.get(
    '/hr/shifts/roster',
    {
      preHandler: [app.loadContext, requirePermission('hr.shifts.view')],
      schema: { querystring: query({ from: v.date, days: v.int(1, 31) }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      await ensureDefaultShift(db, orgId);

      const start = request.query.from ?? toISODate(new Date());
      const span = request.query.days ?? 7;

      const dates = [];
      const cursor = new Date(`${start}T00:00:00Z`);
      for (let i = 0; i < span; i += 1) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      const people = await db.rows(
        `SELECT e.id, e.first_name, e.last_name, e.employee_code, d.name AS department_name
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
          WHERE e.org_id = $1 AND e.archived_at IS NULL AND e.status <> 'exited'
          ORDER BY e.first_name, e.last_name`,
        [orgId],
      );

      const leave = await db.rows(
        `SELECT employee_id, start_date, end_date FROM leave_requests
          WHERE org_id = $1 AND status = 'approved'
            AND start_date <= $3::date AND end_date >= $2::date`,
        [orgId, dates[0], dates[dates.length - 1]],
      );

      const rows = [];
      let expectedMinutes = 0;
      const perDate = Object.fromEntries(dates.map((d) => [d, { working: 0, on_leave: 0, off: 0 }]));

      for (const person of people) {
        const cells = [];
        for (const date of dates) {
          const shift = await shiftForEmployee(db, orgId, person.id, date);
          const onLeave = leave.some(
            (l) => l.employee_id === person.id
              && toISODate(l.start_date) <= date && toISODate(l.end_date) >= date,
          );
          const working = shift ? isWorkingDay(shift, date) : false;

          if (onLeave) perDate[date].on_leave += 1;
          else if (working) { perDate[date].working += 1; expectedMinutes += shiftMinutes(shift); }
          else perDate[date].off += 1;

          cells.push({
            date,
            state: onLeave ? 'leave' : working ? 'working' : 'off',
            shift_id: shift?.id ?? null,
            shift_name: shift?.name ?? null,
            window: shift && working
              ? `${String(shift.starts_at).slice(0, 5)}–${String(shift.ends_at).slice(0, 5)}`
              : null,
          });
        }

        rows.push({
          employee_id: person.id,
          name: [person.first_name, person.last_name].filter(Boolean).join(' '),
          employee_code: person.employee_code,
          department_name: person.department_name,
          cells,
        });
      }

      return {
        data: rows,
        meta: {
          dates,
          per_date: perDate,
          expected_minutes: expectedMinutes,
          expected_hours: formatMinutes(expectedMinutes),
          headcount: people.length,
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════ PREVIEW
  /** What the current settings would pay for a given day — used by the editor. */
  app.post(
    '/hr/shifts/preview',
    {
      preHandler: [app.loadContext, requirePermission('hr.shifts.view')],
      schema: {
        body: body(
          {
            starts_at: timeOfDay, ends_at: timeOfDay, break_minutes: v.int(0, 480),
            grace_minutes: v.int(0, 120), half_day_minutes: v.int(0, 720),
            overtime_after_minutes: v.int(0, 480), working_days: weekdays,
            on_date: v.date, check_in_at: v.datetime, check_out_at: v.datetime,
          },
          [],
        ),
      },
    },
    async (request) => {
      const b = request.body;
      const shift = {
        starts_at: b.starts_at ?? '09:00',
        ends_at: b.ends_at ?? '18:00',
        break_minutes: b.break_minutes ?? 60,
        grace_minutes: b.grace_minutes ?? 10,
        half_day_minutes: b.half_day_minutes ?? 240,
        overtime_after_minutes: b.overtime_after_minutes ?? 0,
        working_days: b.working_days ?? [1, 2, 3, 4, 5],
        is_night_shift: (b.ends_at ?? '18:00') <= (b.starts_at ?? '09:00'),
      };

      const onDate = b.on_date ?? toISODate(new Date());
      const derived = deriveDay({
        shift,
        onDate,
        checkIn: b.check_in_at ?? null,
        checkOut: b.check_out_at ?? null,
        workMinutes: null,
      });

      return {
        data: {
          ...derived,
          paid_minutes: shiftMinutes(shift),
          paid_hours: formatMinutes(shiftMinutes(shift)),
          overtime_hours: formatMinutes(derived.overtime_minutes),
          shortfall_hours: formatMinutes(derived.shortfall_minutes),
          is_night_shift: shift.is_night_shift,
          is_working_day: isWorkingDay(shift, onDate),
        },
      };
    },
  );
}
