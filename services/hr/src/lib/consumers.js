import { EVENTS } from '@nexus/contracts/events';
import { usesHr } from './workspace-people.js';

/**
 * Linking an employee record to a platform login.
 *
 * HR sends a portal invitation through tenancy, but tenancy is the service
 * that learns when it is accepted. Rather than polling, HR listens for the
 * membership event and matches on the email it invited — the one piece of
 * information both sides already agree on.
 *
 * Matching by email is safe here precisely because HR chose the address: the
 * invitation was sent to the address on the employee record, so an acceptance
 * for that address is an acceptance by that employee.
 */
export async function registerConsumers({ bus, db, logger, workspacePeople }) {
  await bus.subscribe('hr', EVENTS.MEMBER_JOINED, async (event) => {
    const { org_id: orgId, data } = event;
    if (!orgId || !data?.user_id || !data?.email) return;

    const email = String(data.email).trim().toLowerCase();

    const linked = await db.one(
      `UPDATE employees
          SET user_id = $3,
              portal_status = 'active',
              portal_linked_at = now()
        WHERE org_id = $1
          AND archived_at IS NULL
          AND user_id IS NULL
          AND portal_status = 'invited'
          AND (lower(email) = $2 OR lower(personal_email) = $2)
        RETURNING id, employee_code, first_name, last_name`,
      [orgId, email, data.user_id],
    );

    if (linked) {
      logger?.info(
        { orgId, employeeId: linked.id, code: linked.employee_code },
        'employee linked to a portal login',
      );
      return;
    }

    // Anyone else who joins the workspace (not a guest) becomes an employee
    // too, once the workspace uses HR — so the two lists never drift apart.
    const roles = data.roles ?? [];
    if (!workspacePeople || (roles.length && roles.every((role) => role === 'guest'))) return;
    if (!(await usesHr(db, orgId))) return;
    await workspacePeople.add(db, { orgId, actorId: null, userIds: [data.user_id] });
  });

  /**
   * Payroll pushes the current salary here so letters can quote it without HR
   * calling payroll — which would make the dependency circular, since payroll
   * already reads HR's roster and attendance.
   *
   * `revised_at` guards against a redelivered or out-of-order event quietly
   * reinstating a superseded figure on an offer letter.
   */
  await bus.subscribe('hr', EVENTS.SALARY_REVISED, async (event) => {
    const { org_id: orgId, data } = event;
    if (!orgId || !data?.employee_id) return;

    await db.query(
      `INSERT INTO employee_salary_snapshot
         (org_id, employee_id, annual_ctc, monthly_gross, currency, effective_from, revised_at)
       VALUES ($1,$2,$3,$4,$5,$6::date,COALESCE($7::timestamptz, now()))
       ON CONFLICT (org_id, employee_id) DO UPDATE SET
         annual_ctc = EXCLUDED.annual_ctc,
         monthly_gross = EXCLUDED.monthly_gross,
         currency = EXCLUDED.currency,
         effective_from = EXCLUDED.effective_from,
         revised_at = EXCLUDED.revised_at,
         updated_at = now()
       WHERE EXCLUDED.revised_at >= employee_salary_snapshot.revised_at`,
      [
        orgId, data.employee_id,
        data.annual_ctc ?? 0, data.monthly_gross ?? 0,
        data.currency ?? 'INR', data.effective_from ?? null,
        event.occurred_at ?? null,
      ],
    );
  });

  /**
   * A member removed from the workspace loses portal access, but stays an
   * employee — being taken off the system is not the same as leaving the job,
   * and unlinking the record would orphan their payslips.
   */
  await bus.subscribe('hr', EVENTS.MEMBER_REMOVED, async (event) => {
    const { org_id: orgId, data } = event;
    if (!orgId || !data?.user_id) return;

    await db.query(
      `UPDATE employees
          SET user_id = NULL, portal_status = 'suspended'
        WHERE org_id = $1 AND user_id = $2`,
      [orgId, data.user_id],
    );
  });
}
