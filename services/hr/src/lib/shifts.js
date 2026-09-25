import { id } from '@nexus/db-kit';
import { deriveDay, foldPunches } from './time.js';
import { toISODate } from './setup.js';

/**
 * Every workspace needs one shift before anybody can be paid for a day, so
 * the first read of any time screen creates a standard one. It is an ordinary
 * row: rename it, re-time it, or replace it as the default.
 */
export async function ensureDefaultShift(db, orgId) {
  const existing = await db.one(
    `SELECT * FROM shifts WHERE org_id = $1 AND is_default AND archived_at IS NULL`,
    [orgId],
  );
  if (existing) return existing;

  try {
    return await db.one(
      `INSERT INTO shifts (id, org_id, name, code, starts_at, ends_at, break_minutes, is_default)
       VALUES ($1,$2,'General shift','GEN','09:00','18:00',60,true) RETURNING *`,
      [id('sft'), orgId],
    );
  } catch {
    // Two first-time requests raced; the partial unique index rejected one.
    return db.one(
      `SELECT * FROM shifts WHERE org_id = $1 AND is_default AND archived_at IS NULL`,
      [orgId],
    );
  }
}

/**
 * The shift one person was on at one date.
 *
 * Falls back to the workspace default, which is what makes shift assignment
 * optional: a workspace that never opens this screen still gets correct hours.
 */
export async function shiftForEmployee(db, orgId, employeeId, onDate) {
  const assigned = await db.one(
    `SELECT s.* FROM employee_shifts es
       JOIN shifts s ON s.id = es.shift_id
      WHERE es.org_id = $1 AND es.employee_id = $2
        AND es.effective_from <= $3::date
        AND (es.effective_to IS NULL OR es.effective_to >= $3::date)
      ORDER BY es.effective_from DESC LIMIT 1`,
    [orgId, employeeId, onDate],
  );
  if (assigned) return assigned;

  return db.one(
    `SELECT * FROM shifts WHERE org_id = $1 AND is_default AND archived_at IS NULL`,
    [orgId],
  );
}

/** One query for a whole roster, so a month's recompute is not N queries deep. */
export async function shiftMapFor(db, orgId, employeeIds, onDate) {
  const rows = await db.rows(
    `SELECT es.employee_id, s.*
       FROM employee_shifts es
       JOIN shifts s ON s.id = es.shift_id
      WHERE es.org_id = $1 AND es.employee_id = ANY($2::text[])
        AND es.effective_from <= $3::date
        AND (es.effective_to IS NULL OR es.effective_to >= $3::date)
      ORDER BY es.employee_id, es.effective_from DESC`,
    [orgId, employeeIds, onDate],
  );

  const map = new Map();
  for (const row of rows) if (!map.has(row.employee_id)) map.set(row.employee_id, row);
  return map;
}

/**
 * Rebuild attendance for a day from that day's punches.
 *
 * Runs inside the caller's transaction so a device batch either lands whole or
 * not at all. Leave wins over punches: somebody who badged in on approved
 * leave is still on leave, and the punch stays on record to be questioned.
 */
export async function rebuildDay(tx, { orgId, employeeId, onDate, shift, recordedBy = 'device' }) {
  const punches = await tx.rows(
    `SELECT punched_at, direction FROM punches
      WHERE org_id = $1 AND employee_id = $2 AND status = 'matched'
        AND (punched_at AT TIME ZONE 'UTC')::date
            BETWEEN $3::date - 1 AND $3::date + 1
      ORDER BY punched_at`,
    [orgId, employeeId, onDate],
  );

  // A night shift's punches straddle midnight, so the day owns everything
  // from its start until the shift length has elapsed.
  const dayPunches = punches.filter((p) => {
    const iso = new Date(p.punched_at).toISOString().slice(0, 10);
    if (iso === onDate) return true;
    if (!shift?.is_night_shift) return false;
    const next = new Date(`${onDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return iso === next.toISOString().slice(0, 10)
      && new Date(p.punched_at).getUTCHours() < 12;
  });

  if (!dayPunches.length) return null;

  const folded = foldPunches(dayPunches, { breakMinutes: shift?.break_minutes ?? 0 });

  const onLeave = await tx.one(
    `SELECT 1 AS yes FROM leave_requests
      WHERE org_id = $1 AND employee_id = $2 AND status = 'approved'
        AND $3::date BETWEEN start_date AND end_date`,
    [orgId, employeeId, onDate],
  );

  const derived = deriveDay({
    shift,
    onDate,
    checkIn: folded.check_in_at,
    checkOut: folded.check_out_at,
    workMinutes: folded.work_minutes,
    status: onLeave ? 'on_leave' : undefined,
  });

  const row = await tx.one(
    `INSERT INTO attendance
       (id, org_id, employee_id, on_date, status, check_in_at, check_out_at, work_minutes,
        shift_id, expected_minutes, overtime_minutes, shortfall_minutes,
        late_minutes, early_exit_minutes, source, recorded_by)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'device',$15)
     ON CONFLICT (org_id, employee_id, on_date) DO UPDATE SET
       status = EXCLUDED.status,
       check_in_at = EXCLUDED.check_in_at,
       check_out_at = EXCLUDED.check_out_at,
       work_minutes = EXCLUDED.work_minutes,
       shift_id = EXCLUDED.shift_id,
       expected_minutes = EXCLUDED.expected_minutes,
       overtime_minutes = EXCLUDED.overtime_minutes,
       shortfall_minutes = EXCLUDED.shortfall_minutes,
       late_minutes = EXCLUDED.late_minutes,
       early_exit_minutes = EXCLUDED.early_exit_minutes,
       source = 'device',
       updated_at = now()
     -- A day an approver has decided by hand is not overwritten by punches
     -- that arrive afterwards. The approver saw the evidence; the punches stay
     -- in the punch log for anybody who wants to question the decision.
     WHERE attendance.source <> 'manual' OR attendance.approved_by IS NULL
     RETURNING *`,
    [
      id('att'), orgId, employeeId, onDate, derived.status,
      folded.check_in_at, folded.check_out_at, derived.work_minutes,
      shift?.id ?? null, derived.expected_minutes, derived.overtime_minutes,
      derived.shortfall_minutes, derived.late_minutes, derived.early_exit_minutes,
      recordedBy,
    ],
  );

  if (!row) return { kept_manual: true, punch_count: folded.punch_count };
  return { ...row, punch_count: folded.punch_count, open: folded.open };
}

/**
 * Re-derive stored attendance against current shift settings.
 *
 * Called after hours change or a shift is reassigned. It recomputes from the
 * stored check-in/out rather than from punches, so manually entered days keep
 * their times and only their arithmetic is corrected.
 */
export async function recomputeRange(db, orgId, { from, to, employeeIds = null, shiftId = null }) {
  const values = [orgId, from, to];
  let filter = '';
  if (employeeIds?.length) {
    values.push(employeeIds);
    filter += ` AND a.employee_id = ANY($${values.length}::text[])`;
  }

  const rows = await db.rows(
    `SELECT a.id, a.employee_id, a.on_date, a.status, a.check_in_at, a.check_out_at, a.work_minutes
       FROM attendance a
      WHERE a.org_id = $1 AND a.on_date BETWEEN $2::date AND $3::date
        AND a.status NOT IN ('on_leave','holiday') ${filter}
      ORDER BY a.on_date`,
    values,
  );
  if (!rows.length) return 0;

  let touched = 0;

  await db.transaction(async (tx) => {
    // Shifts are dated, so the right one depends on the row's own date.
    const cache = new Map();

    for (const row of rows) {
      const onDate = toISODate(row.on_date);
      const key = `${row.employee_id}:${onDate}`;
      if (!cache.has(key)) cache.set(key, await shiftForEmployee(tx, orgId, row.employee_id, onDate));
      const shift = cache.get(key);

      // A recompute scoped to one shift leaves everyone else's days alone.
      if (shiftId && shift?.id !== shiftId) continue;

      const derived = deriveDay({
        shift,
        onDate,
        checkIn: row.check_in_at,
        checkOut: row.check_out_at,
        // Trust a stored figure; only compute one when the times allow it.
        workMinutes: row.work_minutes,
        status: row.status,
      });

      await tx.query(
        `UPDATE attendance
            SET shift_id = $2, expected_minutes = $3, overtime_minutes = $4,
                shortfall_minutes = $5, late_minutes = $6, early_exit_minutes = $7,
                updated_at = now()
          WHERE id = $1`,
        [
          row.id, shift?.id ?? null, derived.expected_minutes, derived.overtime_minutes,
          derived.shortfall_minutes, derived.late_minutes, derived.early_exit_minutes,
        ],
      );
      touched += 1;
    }
  });

  return touched;
}

/**
 * The per-period summary payroll reads.
 *
 * HR owns time, payroll owns money — this is the whole of the seam between
 * them. Returned as plain numbers so the caller need not know how a day was
 * recorded, only how many of them were worked.
 */
export async function periodSummary(db, orgId, { from, to, employeeIds = null }) {
  const values = [orgId, from, to];
  let filter = '';
  if (employeeIds?.length) {
    values.push(employeeIds);
    filter = ` AND a.employee_id = ANY($${values.length}::text[])`;
  }

  const rows = await db.rows(
    `SELECT a.employee_id,
            count(*) FILTER (WHERE a.status IN ('present','remote'))::int AS days_present,
            count(*) FILTER (WHERE a.status = 'half_day')::int            AS days_half,
            count(*) FILTER (WHERE a.status = 'absent')::int              AS days_absent,
            count(*) FILTER (WHERE a.status = 'on_leave')::int            AS days_leave,
            COALESCE(sum(a.work_minutes), 0)::int                         AS work_minutes,
            COALESCE(sum(a.expected_minutes), 0)::int                     AS expected_minutes,
            COALESCE(sum(a.overtime_minutes), 0)::int                     AS overtime_minutes,
            COALESCE(sum(a.shortfall_minutes), 0)::int                    AS shortfall_minutes,
            COALESCE(sum(a.late_minutes), 0)::int                         AS late_minutes
       FROM attendance a
      WHERE a.org_id = $1 AND a.on_date BETWEEN $2::date AND $3::date ${filter}
      GROUP BY a.employee_id`,
    values,
  );

  return rows;
}
