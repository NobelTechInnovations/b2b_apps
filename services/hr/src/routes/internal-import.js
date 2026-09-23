import { id } from '@nexus/db-kit';
import { requireInternal } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { nextEmployeeCode, ensureLeaveTypes } from '../lib/setup.js';

/**
 * Receives validated rows from the Documents import wizard.
 *
 * HR still applies its own rules: codes are generated when the sheet omits
 * them, named departments are matched or created, and every imported employee
 * gets this year's leave balances — so a bulk import leaves the same state a
 * hand-entered hire would.
 */
export async function internalImportRoutes(app) {
  const { db } = app;

  const orgOf = (request) => {
    const orgId = request.headers['x-nexus-org'];
    if (!orgId) throw app.httpErrors.badRequest('missing org context');
    return orgId;
  };
  const actorOf = (request) => request.headers['x-nexus-actor'] || null;

  app.post('/internal/import/employees/existing', { preHandler: requireInternal() }, async (request) => {
    const orgId = orgOf(request);
    const values = (request.body?.values ?? []).map((v) => String(v).toLowerCase());
    if (!values.length) return { data: { keys: [] } };

    const rows = await db.rows(
      `SELECT lower(email) AS key FROM employees
        WHERE org_id = $1 AND lower(email) = ANY($2) AND archived_at IS NULL`,
      [orgId, values],
    );
    return { data: { keys: rows.map((r) => r.key) } };
  });

  app.post('/internal/import/employees', { preHandler: requireInternal() }, async (request) => {
    const orgId = orgOf(request);
    const userId = actorOf(request);
    const year = new Date().getFullYear();
    const results = [];

    // A bulk import may be the very first thing a workspace does in HR, so the
    // leave policy has to exist before anyone is hired into it.
    await ensureLeaveTypes(db, orgId);

    for (const row of request.body?.rows ?? []) {
      const data = row.data ?? {};
      try {
        const result = await db.transaction(async (tx) => {
          // Departments named in the sheet are matched case-insensitively,
          // and created once if genuinely new.
          let departmentId = null;
          if (data.department_name) {
            const existing = await tx.one(
              `SELECT id FROM departments
                WHERE org_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL`,
              [orgId, data.department_name],
            );
            departmentId = existing?.id
              ?? (await tx.one(
                `INSERT INTO departments (id, org_id, name) VALUES ($1,$2,$3) RETURNING id`,
                [id('dep'), orgId, String(data.department_name).trim()],
              )).id;
          }

          if (data.email) {
            const existing = await tx.one(
              `SELECT id FROM employees
                WHERE org_id = $1 AND lower(email) = lower($2) AND archived_at IS NULL`,
              [orgId, data.email],
            );

            if (existing) {
              const updated = await tx.one(
                `UPDATE employees SET
                   first_name      = COALESCE($3, first_name),
                   last_name       = COALESCE($4, last_name),
                   phone           = COALESCE($5, phone),
                   designation     = COALESCE($6, designation),
                   department_id   = COALESCE($7, department_id),
                   employment_type = COALESCE($8, employment_type),
                   joined_on       = COALESCE($9::date, joined_on),
                   date_of_birth   = COALESCE($10::date, date_of_birth),
                   gender          = COALESCE($11, gender),
                   work_location   = COALESCE($12, work_location)
                 WHERE id = $1 AND org_id = $2 RETURNING id`,
                [existing.id, orgId, data.first_name ?? null, data.last_name ?? null,
                 data.phone ?? null, data.designation ?? null, departmentId,
                 data.employment_type ?? null, data.joined_on ?? null,
                 data.date_of_birth ?? null, data.gender ?? null, data.work_location ?? null],
              );
              return { outcome: 'updated', id: updated.id };
            }
          }

          // A code from the sheet is honoured unless it clashes; otherwise
          // the next in the EMP-001 sequence is generated.
          let code = data.employee_code ? String(data.employee_code).trim() : null;
          if (code) {
            const clash = await tx.one(
              `SELECT 1 AS yes FROM employees
                WHERE org_id = $1 AND lower(employee_code) = lower($2) AND archived_at IS NULL`,
              [orgId, code],
            );
            if (clash) code = null;
          }
          if (!code) code = await nextEmployeeCode(tx, orgId);

          const created = await tx.one(
            `INSERT INTO employees
               (id, org_id, employee_code, first_name, last_name, email, phone,
                designation, department_id, employment_type, joined_on, date_of_birth,
                gender, work_location, created_by, tags)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'full_time'),
                     COALESCE($11::date, current_date),$12::date,$13,$14,$15,ARRAY['imported'])
             RETURNING id`,
            [id('emp'), orgId, code, data.first_name, data.last_name ?? null,
             data.email ?? null, data.phone ?? null, data.designation ?? null,
             departmentId, data.employment_type ?? null, data.joined_on ?? null,
             data.date_of_birth ?? null, data.gender ?? null, data.work_location ?? null, userId],
          );

          // Same as a hand-entered hire: open this year's balances.
          await tx.query(
            `INSERT INTO leave_balances (org_id, employee_id, leave_type_id, year, entitled)
             SELECT $1, $2, lt.id, $3, lt.days_per_year
               FROM leave_types lt WHERE lt.org_id = $1 AND lt.archived_at IS NULL
             ON CONFLICT DO NOTHING`,
            [orgId, created.id, year],
          );

          return { outcome: 'created', id: created.id };
        });

        results.push({ row_number: row.row_number, ...result });
      } catch (error) {
        request.log.warn({ err: error, row: row.row_number }, 'employee import row failed');
        results.push({ row_number: row.row_number, outcome: 'failed', error: error.message?.slice(0, 200) });
      }
    }

    return { data: { results } };
  });
}
