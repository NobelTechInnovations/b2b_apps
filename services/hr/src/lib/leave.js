import { id } from '@nexus/db-kit';
import { badRequest, conflict } from '@nexus/service-kit';
import { workingDays, datesBetween } from './setup.js';

/**
 * Leave, in one place.
 *
 * Both HR and the employee portal create leave requests, and they must apply
 * exactly the same rules — an employee applying for themselves cannot be
 * allowed past a balance check that HR enforces. The difference between the
 * two callers is only WHO the request is for, which is why `employeeId` is a
 * parameter and never read from a request body here.
 */

/** Days remaining, by the platform's one definition: entitled + carried − used. */
export async function balanceFor(db, { orgId, employeeId, leaveTypeId, year }) {
  const row = await db.one(
    `SELECT COALESCE(lb.entitled, lt.days_per_year) AS entitled,
            COALESCE(lb.carried, 0) AS carried,
            COALESCE(lb.used, 0) AS used
       FROM leave_types lt
       LEFT JOIN leave_balances lb
         ON lb.leave_type_id = lt.id AND lb.employee_id = $2 AND lb.year = $4
      WHERE lt.id = $3 AND lt.org_id = $1`,
    [orgId, employeeId, leaveTypeId, year],
  );
  if (!row) return null;

  return {
    ...row,
    available: Number(row.entitled) + Number(row.carried) - Number(row.used),
  };
}

/** Every leave type with this person's balance against it. */
export async function balancesFor(db, { orgId, employeeId, year }) {
  const rows = await db.rows(
    `SELECT lt.id AS leave_type_id, lt.name, lt.code, lt.colour, lt.is_paid,
            lt.requires_approval,
            COALESCE(lb.entitled, lt.days_per_year) AS entitled,
            COALESCE(lb.carried, 0) AS carried,
            COALESCE(lb.used, 0) AS used
       FROM leave_types lt
       LEFT JOIN leave_balances lb
         ON lb.leave_type_id = lt.id AND lb.employee_id = $2 AND lb.year = $3
      WHERE lt.org_id = $1 AND lt.archived_at IS NULL
      ORDER BY lt.position`,
    [orgId, employeeId, year],
  );

  return rows.map((r) => ({
    ...r,
    available: Number(r.entitled) + Number(r.carried) - Number(r.used),
  }));
}

/**
 * Validate a leave request without writing anything.
 *
 * Returns the resolved type and day count, or throws the same error the HR
 * screen would show. Separated from the write so a portal can preview the
 * decision before committing to it.
 */
export async function checkLeaveRequest(db, { orgId, employeeId, leaveTypeId, startDate, endDate, halfDay }) {
  if (endDate < startDate) throw badRequest('The end date is before the start date.');

  const type = await db.one(
    `SELECT * FROM leave_types WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
    [leaveTypeId, orgId],
  );
  if (!type) throw badRequest('That leave type does not exist.');

  const days = workingDays(startDate, endDate, halfDay);
  if (days <= 0) throw badRequest('Those dates contain no working days.');

  const overlap = await db.one(
    `SELECT id, status, start_date, end_date FROM leave_requests
      WHERE org_id = $1 AND employee_id = $2
        AND status IN ('pending','approved')
        AND start_date <= $4::date AND end_date >= $3::date
      LIMIT 1`,
    [orgId, employeeId, startDate, endDate],
  );
  if (overlap) {
    throw conflict(
      `This overlaps an existing ${overlap.status} request from ${overlap.start_date} to ${overlap.end_date}.`,
      { conflicting_request_id: overlap.id },
    );
  }

  const year = new Date(`${startDate}T00:00:00Z`).getUTCFullYear();
  const balance = await balanceFor(db, { orgId, employeeId, leaveTypeId, year });
  const available = balance?.available ?? Number(type.days_per_year);

  // Unpaid leave has no balance to exhaust.
  if (type.is_paid && days > available) {
    throw badRequest(
      `Only ${available} day${available === 1 ? '' : 's'} of ${type.name} remain, but this request is for ${days}.`,
      { available, requested: days },
    );
  }

  return { type, days, available, year };
}

/**
 * Deduct the balance and block out the calendar.
 *
 * Attendance rows are upserted rather than inserted: someone may already have
 * been marked present for a day that later becomes leave.
 */
export async function applyApproval(tx, { orgId, request, type, userId }) {
  const year = new Date(`${request.start_date}T00:00:00Z`).getUTCFullYear();

  if (type.is_paid !== false) {
    await tx.query(
      `INSERT INTO leave_balances (org_id, employee_id, leave_type_id, year, entitled, used)
       VALUES ($1, $2, $3, $4,
               COALESCE((SELECT days_per_year FROM leave_types WHERE id = $3), 0), $5)
       ON CONFLICT (employee_id, leave_type_id, year)
       DO UPDATE SET used = leave_balances.used + $5, updated_at = now()`,
      [orgId, request.employee_id, request.leave_type_id, year, request.days],
    );
  }

  for (const day of datesBetween(request.start_date, request.end_date)) {
    await tx.query(
      `INSERT INTO attendance (id, org_id, employee_id, on_date, status, recorded_by)
       VALUES ($1, $2, $3, $4, 'on_leave', $5)
       ON CONFLICT (org_id, employee_id, on_date)
       DO UPDATE SET status = 'on_leave', updated_at = now()`,
      [id('att'), orgId, request.employee_id, day, userId],
    );
  }
}
