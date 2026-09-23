import { id } from '@nexus/db-kit';
import { EVENTS } from '@nexus/contracts/events';
import {
  requirePermission, body, params, query, validate as v, notFound, badRequest,
} from '@nexus/service-kit';
import { toPaise, toRupees } from '../lib/money.js';
import { buildPayslip } from '../lib/payroll.js';
import {
  ensurePayrollSetup, structureComponents, defaultStructure, periodFor,
} from '../lib/setup.js';

export async function salaryRoutes(app) {
  const { db, hr } = app;

  // ═══════════════════════════════════════════════════════════════════ LIST
  /**
   * Everyone on the payroll, and everyone who is not yet.
   *
   * The roster comes from HR and the money comes from here, joined in memory
   * rather than in SQL — the only correct way to join across two databases.
   */
  app.get(
    '/payroll/salaries',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.view')],
      schema: { querystring: query({ unassigned: v.bool, department_id: v.id('dep') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      await ensurePayrollSetup(db, orgId);

      const employees = await hr.employees(orgId);

      const salaries = await db.rows(
        `SELECT es.*, s.name AS structure_name
           FROM employee_salaries es
           LEFT JOIN salary_structures s ON s.id = es.structure_id
          WHERE es.org_id = $1 AND es.effective_to IS NULL`,
        [orgId],
      );
      const byEmployee = new Map(salaries.map((s) => [s.employee_id, s]));

      let data = employees.map((employee) => {
        const salary = byEmployee.get(employee.id) ?? null;
        return {
          employee_id: employee.id,
          name: employee.name,
          employee_code: employee.employee_code,
          designation: employee.designation,
          department_id: employee.department_id,
          department_name: employee.department_name,
          joined_on: employee.joined_on,
          status: employee.status,
          salary_id: salary?.id ?? null,
          structure_id: salary?.structure_id ?? null,
          structure_name: salary?.structure_name ?? null,
          annual_ctc: salary?.annual_ctc ?? null,
          monthly_gross: salary?.monthly_gross ?? null,
          effective_from: salary?.effective_from ?? null,
          payment_mode: salary?.payment_mode ?? null,
          has_bank: Boolean(salary?.bank_account),
          on_payroll: Boolean(salary),
        };
      });

      if (request.query.department_id) {
        data = data.filter((r) => r.department_id === request.query.department_id);
      }
      if (request.query.unassigned) data = data.filter((r) => !r.on_payroll);

      const onPayroll = data.filter((r) => r.on_payroll);
      const monthlyTotal = onPayroll.reduce((sum, r) => sum + toPaise(r.monthly_gross), 0);

      return {
        data,
        meta: {
          total: data.length,
          on_payroll: onPayroll.length,
          not_on_payroll: data.length - onPayroll.length,
          monthly_gross_total: toRupees(monthlyTotal),
          annual_gross_total: toRupees(monthlyTotal * 12),
        },
      };
    },
  );

  // ════════════════════════════════════════════════════════════════ HISTORY
  app.get(
    '/payroll/salaries/:employeeId',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.view')],
      schema: { params: params({ employeeId: v.id('emp') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const history = await db.rows(
        `SELECT es.*, s.name AS structure_name
           FROM employee_salaries es
           LEFT JOIN salary_structures s ON s.id = es.structure_id
          WHERE es.org_id = $1 AND es.employee_id = $2
          ORDER BY es.effective_from DESC`,
        [orgId, request.params.employeeId],
      );
      if (!history.length) throw notFound('Salary');

      const [employee] = await hr.employees(orgId, { employeeIds: [request.params.employeeId] });

      // A raise is only meaningful next to the one before it.
      const withDeltas = history.map((row, index) => {
        const previous = history[index + 1];
        if (!previous) return { ...row, change_percent: null, change_amount: null };
        const before = toPaise(previous.annual_ctc);
        const after = toPaise(row.annual_ctc);
        return {
          ...row,
          change_amount: toRupees(after - before),
          change_percent: before ? Math.round(((after - before) / before) * 1000) / 10 : null,
        };
      });

      const payslips = await db.rows(
        `SELECT p.id, p.payslip_number, p.net_pay, p.gross_earnings, p.status,
                r.label, r.period_year, r.period_month
           FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
          WHERE p.org_id = $1 AND p.employee_id = $2
          ORDER BY r.period_year DESC, r.period_month DESC LIMIT 12`,
        [orgId, request.params.employeeId],
      );

      return {
        data: {
          employee: employee ?? { id: request.params.employeeId, name: 'Unknown employee' },
          current: withDeltas.find((r) => !r.effective_to) ?? withDeltas[0],
          history: withDeltas,
          payslips,
        },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════ SET / REVISE
  /**
   * Record a salary, or revise one.
   *
   * A revision never edits the standing row — it closes it the day before the
   * new one starts. That is what lets a payslip from before the raise still
   * reproduce itself exactly.
   */
  app.post(
    '/payroll/salaries',
    {
      preHandler: [app.loadContext, requirePermission('payroll.structures.manage')],
      schema: {
        body: body(
          {
            employee_id: v.id('emp'),
            structure_id: v.id('str'),
            annual_ctc: v.money,
            monthly_gross: v.money,
            effective_from: v.date,
            revision_note: v.text(300),
            pan: v.text(20), uan: v.text(30), esi_number: v.text(30),
            bank_account: v.text(40), bank_ifsc: v.text(20), bank_name: v.text(80),
            payment_mode: v.enum(['bank', 'cash', 'cheque', 'upi']),
          },
          ['employee_id'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;
      await ensurePayrollSetup(db, orgId);

      const [employee] = await hr.employees(orgId, { employeeIds: [b.employee_id] });
      if (!employee) throw notFound('Employee');

      if (!b.annual_ctc && !b.monthly_gross) {
        throw badRequest('Give either an annual CTC or a monthly gross.');
      }

      const annual = b.annual_ctc ? toPaise(b.annual_ctc) : toPaise(b.monthly_gross) * 12;
      const monthly = b.monthly_gross ? toPaise(b.monthly_gross) : Math.round(annual / 12);

      const structure = b.structure_id
        ? await db.one(`SELECT * FROM salary_structures WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [b.structure_id, orgId])
        : await defaultStructure(db, orgId);
      if (!structure) throw badRequest('No salary structure to apply. Create one first.');

      const from = b.effective_from ?? new Date().toISOString().slice(0, 10);

      const row = await db.transaction(async (tx) => {
        const current = await tx.one(
          `SELECT * FROM employee_salaries
            WHERE org_id = $1 AND employee_id = $2 AND effective_to IS NULL`,
          [orgId, b.employee_id],
        );

        if (current) {
          if (current.effective_from >= from) {
            // Correcting a salary that has not started yet is a correction,
            // not a revision — there is no history worth preserving.
            await tx.query(`DELETE FROM employee_salaries WHERE id = $1`, [current.id]);
          } else {
            await tx.query(
              `UPDATE employee_salaries SET effective_to = $2::date - 1 WHERE id = $1`,
              [current.id, from],
            );
          }
        }

        const saved = await tx.one(
          `INSERT INTO employee_salaries
             (id, org_id, employee_id, structure_id, annual_ctc, monthly_gross,
              effective_from, revision_note, pan, uan, esi_number,
              bank_account, bank_ifsc, bank_name, payment_mode, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING *`,
          [
            id('sal'), orgId, b.employee_id, structure.id,
            toRupees(annual), toRupees(monthly), from,
            b.revision_note ?? null,
            // Statutory identifiers carry over from the previous record unless
            // this revision supplies new ones; re-typing a PAN to give a raise
            // is exactly the kind of thing that gets typed wrong.
            b.pan ?? current?.pan ?? null,
            b.uan ?? current?.uan ?? null,
            b.esi_number ?? current?.esi_number ?? null,
            b.bank_account ?? current?.bank_account ?? null,
            b.bank_ifsc ?? current?.bank_ifsc ?? null,
            b.bank_name ?? current?.bank_name ?? null,
            b.payment_mode ?? current?.payment_mode ?? 'bank',
            userId,
          ],
        );

        // HR quotes this on offer and appointment letters. Pushing it keeps
        // the dependency one-way: payroll reads HR, never the other way round.
        tx.emit({
          type: EVENTS.SALARY_REVISED,
          org_id: orgId,
          actor_id: userId,
          data: {
            employee_id: b.employee_id,
            annual_ctc: saved.annual_ctc,
            monthly_gross: saved.monthly_gross,
            effective_from: saved.effective_from,
            currency: 'INR',
            is_revision: Boolean(current),
          },
        });

        return saved;
      });

      return reply.status(201).send({
        data: { ...row, structure_name: structure.name, employee_name: employee.name },
      });
    },
  );

  // ═══════════════════════════════════════════════════════════════ PREVIEW
  /**
   * What this person's payslip would look like this month, without creating
   * anything. Uses the same engine a real run does, so the preview is not a
   * separate approximation that can drift from the truth.
   */
  app.post(
    '/payroll/salaries/:employeeId/preview',
    {
      preHandler: [app.loadContext, requirePermission('payroll.payslips.view')],
      schema: {
        params: params({ employeeId: v.id('emp') }),
        body: body({ year: v.int(2000, 2100), month: v.int(1, 12) }, []),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const settings = await ensurePayrollSetup(db, orgId);

      const now = new Date();
      const period = periodFor(
        request.body.year ?? now.getFullYear(),
        request.body.month ?? now.getMonth() + 1,
      );

      const salary = await db.one(
        `SELECT * FROM employee_salaries
          WHERE org_id = $1 AND employee_id = $2
            AND effective_from <= $3::date
            AND (effective_to IS NULL OR effective_to >= $3::date)
          ORDER BY effective_from DESC LIMIT 1`,
        [orgId, request.params.employeeId, period.end],
      );
      if (!salary) throw badRequest('This person has no salary on record for that month.');

      const [employee] = await hr.employees(orgId, { employeeIds: [request.params.employeeId] });
      if (!employee) throw notFound('Employee');

      const [attendance] = await hr
        .attendance(orgId, { from: period.start, to: period.end, employeeIds: [request.params.employeeId] })
        .catch(() => []);

      const components = await structureComponents(db, orgId, salary.structure_id);
      if (!components.length) throw badRequest('That salary structure has no components.');

      const slip = buildPayslip({
        employee,
        salary,
        components,
        attendance: attendance ?? null,
        settings,
        period,
      });

      return { data: presentSlip(slip, period, settings) };
    },
  );
}

/** Paise → rupee strings, once, at the edge. */
export function presentSlip(slip, period, settings) {
  const money = (paise) => toRupees(paise);

  return {
    ...slip,
    period: { label: period.label, start: period.start, end: period.end },
    currency: settings.currency,
    monthly_gross: money(slip.monthly_gross),
    gross_earnings: money(slip.gross_earnings),
    total_deductions: money(slip.total_deductions),
    net_pay: money(slip.net_pay),
    employer_contrib: money(slip.employer_contrib),
    ctc_for_period: money(slip.ctc_for_period),
    earnings: slip.lines.filter((l) => l.kind === 'earning').map((l) => ({ ...l, amount: money(l.amount) })),
    deductions: slip.lines.filter((l) => l.kind === 'deduction').map((l) => ({ ...l, amount: money(l.amount) })),
    employer: slip.lines.filter((l) => l.kind === 'employer').map((l) => ({ ...l, amount: money(l.amount) })),
    lines: undefined,
    working: undefined,
  };
}
