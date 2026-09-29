import { id } from '@nexus/db-kit';
import { EVENTS } from '@nexus/contracts/events';
import { nextEmployeeCode } from './setup.js';

/**
 * Create one employee inside the caller's transaction: the record, this
 * year's leave balances and the `hr.employee.created` event. Used by the HR
 * screen and by Recruitment's "hire", so both follow exactly the same rules.
 * The caller has already run ensureLeaveTypes() and any duplicate checks.
 */
export async function insertEmployee(tx, { orgId, userId, fields: b }) {
  const code = b.employee_code?.trim() || (await nextEmployeeCode(tx, orgId));

  const created = await tx.one(
    `INSERT INTO employees
       (id, org_id, employee_code, first_name, last_name, email, personal_email, phone,
        date_of_birth, gender, department_id, designation, manager_id, employment_type,
        status, work_location, joined_on, probation_ends_on, address, emergency_contact,
        notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             COALESCE($14,'full_time'), COALESCE($15,'active'), $16,
             COALESCE($17::date, current_date), $18, $19, $20, $21, $22)
     RETURNING *`,
    [
      id('emp'), orgId, code, b.first_name.trim(), b.last_name ?? null,
      b.email ?? null, b.personal_email ?? null, b.phone ?? null,
      b.date_of_birth ?? null, b.gender ?? null, b.department_id ?? null,
      b.designation ?? null, b.manager_id ?? null, b.employment_type ?? null,
      b.status ?? null, b.work_location ?? null, b.joined_on ?? null,
      b.probation_ends_on ?? null, JSON.stringify(b.address ?? {}),
      JSON.stringify(b.emergency_contact ?? {}), b.notes ?? null, userId,
    ],
  );

  // Open this year's leave balances from the workspace's policy, so the
  // entitlement is a real row rather than something computed on the fly
  // and impossible to adjust for one person.
  const year = new Date().getFullYear();
  await tx.query(
    `INSERT INTO leave_balances (org_id, employee_id, leave_type_id, year, entitled)
     SELECT $1, $2, lt.id, $3, lt.days_per_year
       FROM leave_types lt WHERE lt.org_id = $1 AND lt.archived_at IS NULL
     ON CONFLICT DO NOTHING`,
    [orgId, created.id, year],
  );

  tx.emit({
    type: EVENTS.EMPLOYEE_CREATED,
    org_id: orgId,
    actor_id: userId,
    data: {
      employee_id: created.id,
      employee_code: created.employee_code,
      name: [created.first_name, created.last_name].filter(Boolean).join(' '),
      email: created.email,
      department_id: created.department_id,
      joined_on: created.joined_on,
    },
  });

  return created;
}
