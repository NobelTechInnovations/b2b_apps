import { id } from '@nexus/db-kit';

/**
 * A workspace gets usable leave types the first time it opens HR, so nobody
 * has to configure a policy before recording their first day off. These match
 * common Indian practice; they are ordinary rows and can be edited or deleted.
 */
const DEFAULT_LEAVE_TYPES = [
  { name: 'Casual leave',    code: 'CL', days: 12, paid: true,  carry: false, colour: 'sky' },
  { name: 'Sick leave',      code: 'SL', days: 12, paid: true,  carry: false, colour: 'rose' },
  { name: 'Earned leave',    code: 'EL', days: 15, paid: true,  carry: true,  colour: 'emerald' },
  { name: 'Unpaid leave',    code: 'LWP', days: 0, paid: false, carry: false, colour: 'slate' },
];

export async function ensureLeaveTypes(db, orgId) {
  const existing = await db.one(
    `SELECT count(*)::int AS n FROM leave_types WHERE org_id = $1 AND archived_at IS NULL`,
    [orgId],
  );
  if (existing.n > 0) return;

  await db.transaction(async (tx) => {
    // Re-check inside the transaction: two first-time requests can race.
    const raced = await tx.one(
      `SELECT count(*)::int AS n FROM leave_types WHERE org_id = $1`,
      [orgId],
    );
    if (raced.n > 0) return;

    for (const [index, type] of DEFAULT_LEAVE_TYPES.entries()) {
      await tx.query(
        `INSERT INTO leave_types (id, org_id, name, code, days_per_year, is_paid, carry_forward, colour, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id('lvt'), orgId, type.name, type.code, type.days, type.paid, type.carry, type.colour, index],
      );
    }
  });
}

/** Next code in the EMP-001 sequence, per workspace. */
export async function nextEmployeeCode(tx, orgId) {
  const row = await tx.one(
    `SELECT employee_code FROM employees
      WHERE org_id = $1 AND employee_code ~ '^EMP-[0-9]+$'
      ORDER BY (substring(employee_code from 5))::int DESC LIMIT 1`,
    [orgId],
  );

  const next = row ? Number(row.employee_code.slice(4)) + 1 : 1;
  return `EMP-${String(next).padStart(3, '0')}`;
}

/**
 * Normalise a date to `YYYY-MM-DD`.
 *
 * These helpers are called with request-body strings AND with values read back
 * from Postgres, which the pg driver hands over as JS Date objects at LOCAL
 * midnight. Interpolating a Date into a template literal yields an unparseable
 * string, and calling .toISOString() on a local-midnight Date can roll the day
 * backwards east of UTC. Both are silent, so normalise explicitly.
 */
export function toISODate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }
  return null;
}

/**
 * Working days between two dates, excluding weekends.
 *
 * Deliberately simple: public holidays are a later feature, and counting them
 * wrongly would be worse than not counting them at all.
 */
export function workingDays(start, end, halfDay = false) {
  const startISO = toISODate(start);
  const endISO = toISODate(end);
  if (!startISO || !endISO) return 0;

  const from = new Date(`${startISO}T00:00:00Z`);
  const to = new Date(`${endISO}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return 0;

  let days = 0;
  for (const cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days += 1;
  }

  if (halfDay && days === 1) return 0.5;
  return days;
}

/** Every date in a range, used to mark attendance when leave is approved. */
export function datesBetween(start, end) {
  const startISO = toISODate(start);
  const endISO = toISODate(end);
  if (!startISO || !endISO) return [];

  const out = [];
  const from = new Date(`${startISO}T00:00:00Z`);
  const to = new Date(`${endISO}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return [];

  for (const cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cursor.toISOString().slice(0, 10));
  }
  return out;
}
