import { id } from '@nexus/db-kit';
import { badRequest, forbidden, notFound } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { deriveDay } from './time.js';
import { shiftForEmployee, ensureDefaultShift } from './shifts.js';

/**
 * Manual attendance, in one place.
 *
 * There are two ways a typed-in day reaches the attendance table: an approver
 * marks it directly, or an approver accepts somebody else's request. Both run
 * through `writeManualDay`, so the arithmetic — shift, overtime, lateness — is
 * identical whichever way the day arrived.
 */

/** Approved leave owns the day; a manual mark over it would contradict it. */
async function assertNotOnLeave(db, { orgId, employeeId, onDate }) {
  const onLeave = await db.one(
    `SELECT 1 AS yes FROM leave_requests
      WHERE org_id = $1 AND employee_id = $2 AND status = 'approved'
        AND $3::date BETWEEN start_date AND end_date`,
    [orgId, employeeId, onDate],
  );
  if (onLeave) {
    throw badRequest('This person has approved leave on that date. Cancel the leave first.');
  }
}

export async function writeManualDay(db, {
  orgId, employeeId, onDate, status, checkIn, checkOut, notes, actorId, approvedBy,
}) {
  await ensureDefaultShift(db, orgId);
  await assertNotOnLeave(db, { orgId, employeeId, onDate });

  const shift = await shiftForEmployee(db, orgId, employeeId, onDate);
  const derived = deriveDay({
    shift, onDate, checkIn: checkIn ?? null, checkOut: checkOut ?? null, workMinutes: null, status,
  });

  const row = await db.one(
    `INSERT INTO attendance
       (id, org_id, employee_id, on_date, status, check_in_at, check_out_at, work_minutes,
        notes, recorded_by, shift_id, expected_minutes, overtime_minutes, shortfall_minutes,
        late_minutes, early_exit_minutes, source, approved_by, approved_at)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'manual',$17,now())
     ON CONFLICT (org_id, employee_id, on_date) DO UPDATE SET
       status = EXCLUDED.status,
       check_in_at = COALESCE(EXCLUDED.check_in_at, attendance.check_in_at),
       check_out_at = COALESCE(EXCLUDED.check_out_at, attendance.check_out_at),
       work_minutes = COALESCE(EXCLUDED.work_minutes, attendance.work_minutes),
       notes = COALESCE(EXCLUDED.notes, attendance.notes),
       shift_id = EXCLUDED.shift_id,
       expected_minutes = EXCLUDED.expected_minutes,
       overtime_minutes = EXCLUDED.overtime_minutes,
       shortfall_minutes = EXCLUDED.shortfall_minutes,
       late_minutes = EXCLUDED.late_minutes,
       early_exit_minutes = EXCLUDED.early_exit_minutes,
       source = 'manual',
       approved_by = EXCLUDED.approved_by,
       approved_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      id('att'), orgId, employeeId, onDate, status,
      checkIn ?? null, checkOut ?? null, derived.work_minutes,
      notes ?? null, actorId, shift?.id ?? null, derived.expected_minutes,
      derived.overtime_minutes, derived.shortfall_minutes,
      derived.late_minutes, derived.early_exit_minutes, approvedBy,
    ],
  );

  return { ...row, shift_name: shift?.name ?? null };
}

/**
 * Raise, or extend, a claim for a day.
 *
 * One open claim per person per day: a check-out after a check-in fills in the
 * open request instead of creating a second one for an approver to reconcile.
 */
export async function raiseRequest(db, {
  orgId, employeeId, onDate, status, checkIn, checkOut, reason, via, actorId,
}) {
  const employee = await db.one(
    `SELECT id, first_name, last_name, user_id FROM employees
      WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
    [employeeId, orgId],
  );
  if (!employee) throw notFound('Employee');

  await assertNotOnLeave(db, { orgId, employeeId, onDate });

  if (checkIn && checkOut && new Date(checkOut) <= new Date(checkIn)) {
    throw badRequest('The check-out time is before the check-in time.');
  }

  const current = await db.one(
    `SELECT status, check_in_at, check_out_at, source, work_minutes
       FROM attendance WHERE org_id = $1 AND employee_id = $2 AND on_date = $3::date`,
    [orgId, employeeId, onDate],
  );

  return db.transaction(async (tx) => {
   const saved = await tx.one(
    `INSERT INTO attendance_requests
       (id, org_id, employee_id, on_date, status, check_in_at, check_out_at,
        reason, via, requested_by, previous)
     VALUES ($1,$2,$3,$4::date,COALESCE($5,'present'),$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (org_id, employee_id, on_date) WHERE decision = 'pending'
     DO UPDATE SET
       -- A check-out carries no status of its own; it must not turn this
       -- morning's "remote" check-in back into "present".
       status = COALESCE($5, attendance_requests.status),
       check_in_at = COALESCE(EXCLUDED.check_in_at, attendance_requests.check_in_at),
       check_out_at = COALESCE(EXCLUDED.check_out_at, attendance_requests.check_out_at),
       reason = COALESCE(EXCLUDED.reason, attendance_requests.reason),
       updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [
      id('arq'), orgId, employeeId, onDate, status ?? null,
      checkIn ?? null, checkOut ?? null, reason ?? null, via, actorId,
      current ? JSON.stringify(current) : null,
    ],
   );

   // Approvers find out without having to check the attendance screen. Only
   // the first claim for a day is announced — a check-out completing this
   // morning's check-in is not a second thing to look at.
   if (saved.inserted) {
     tx.emit({
       type: EVENTS.ATTENDANCE_REQUESTED,
       org_id: orgId,
       actor_id: actorId,
       data: {
         request_id: saved.id,
         employee_id: employeeId,
         employee_user_id: employee.user_id,
         employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
         on_date: saved.on_date,
         via,
         reason: saved.reason,
       },
     });
   }

   const { inserted: _inserted, ...row } = saved;
   return row;
  });
}

/**
 * Approve or reject a claim.
 *
 * Nobody decides their own claim. An approver who is also an employee files
 * requests like anybody else, and someone else has to accept them — otherwise
 * the approval step is a formality the person it constrains can skip.
 */
export async function decideRequest(db, { orgId, requestId, decision, note, actorId }) {
  return db.transaction(async (tx) => {
    const request = await tx.one(
      `SELECT * FROM attendance_requests WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [requestId, orgId],
    );
    if (!request) throw notFound('Attendance request');
    if (request.decision !== 'pending') {
      throw badRequest(`This request was already ${request.decision}.`);
    }
    const subject = await tx.one(`SELECT user_id FROM employees WHERE id = $1`, [request.employee_id]);
    // Two ways to be too close to a claim: having raised it, or being the
    // person it is about.
    if (request.requested_by === actorId || subject?.user_id === actorId) {
      throw forbidden('You cannot approve your own attendance request. Ask another approver.', {
        code: 'self_approval',
      });
    }

    let attendance = null;
    if (decision === 'approved') {
      attendance = await writeManualDay(tx, {
        orgId,
        employeeId: request.employee_id,
        onDate: typeof request.on_date === 'string' ? request.on_date : request.on_date,
        status: request.status,
        checkIn: request.check_in_at,
        checkOut: request.check_out_at,
        notes: request.reason,
        actorId: request.requested_by,
        approvedBy: actorId,
      });
    }

    const updated = await tx.one(
      `UPDATE attendance_requests
          SET decision = $3, decided_by = $4, decided_at = now(),
              decision_note = $5, attendance_id = $6
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [requestId, orgId, decision, actorId, note ?? null, attendance?.id ?? null],
    );

    const employee = await tx.one(
      `SELECT first_name, last_name, user_id FROM employees WHERE id = $1`,
      [request.employee_id],
    );

    tx.emit({
      type: EVENTS.ATTENDANCE_DECIDED,
      org_id: orgId,
      actor_id: actorId,
      data: {
        request_id: updated.id,
        decision,
        note: note ?? null,
        on_date: updated.on_date,
        requested_by: request.requested_by,
        employee_id: request.employee_id,
        employee_user_id: employee?.user_id ?? null,
        employee_name: [employee?.first_name, employee?.last_name].filter(Boolean).join(' '),
        via: request.via,
      },
    });

    return { request: updated, attendance };
  });
}
