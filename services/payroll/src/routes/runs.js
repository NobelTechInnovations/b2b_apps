import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, params, query, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';
import { toPaise, toRupees } from '../lib/money.js';
import { buildPayslip } from '../lib/payroll.js';
import {
  ensurePayrollSetup, structureComponents, periodFor, nextPayslipNumber, fiscalYear,
} from '../lib/setup.js';
import { EVENTS } from '@nexus/contracts/events';

/**
 * A run moves draft → review → approved → paid, and may be cancelled from
 * anywhere before it is paid. Each step is one-way: money that has left the
 * building cannot be un-sent, so there is no path back from `paid`.
 */
const NEXT_STATUS = {
  draft: ['review', 'cancelled'],
  review: ['approved', 'draft', 'cancelled'],
  approved: ['paid', 'review', 'cancelled'],
  paid: [],
  cancelled: [],
};

export async function runRoutes(app) {
  const { db, hr } = app;

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/payroll/runs',
    {
      preHandler: [app.loadContext, requirePermission('payroll.runs.view')],
      schema: {
        querystring: query({
          status: v.enum(['draft', 'review', 'approved', 'paid', 'cancelled']),
          year: v.int(2000, 2100),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      await ensurePayrollSetup(db, orgId);

      const page = paginate({ ...request.query, allowedSorts: ['period_year', 'created_at'] });
      const where = ['org_id = $1'];
      const values = [orgId];

      if (request.query.status) { values.push(request.query.status); where.push(`status = $${values.length}`); }
      if (request.query.year) { values.push(request.query.year); where.push(`period_year = $${values.length}`); }

      const clause = where.join(' AND ');

      const [rows, total, ytd] = await Promise.all([
        db.rows(
          `SELECT * FROM payroll_runs WHERE ${clause}
            ORDER BY period_year DESC, period_month DESC
            LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM payroll_runs WHERE ${clause}`, values),
        db.one(
          `SELECT COALESCE(sum(net_total),0) AS net, COALESCE(sum(gross_total),0) AS gross,
                  COALESCE(sum(employer_cost),0) AS employer, count(*)::int AS runs
             FROM payroll_runs
            WHERE org_id = $1 AND status IN ('approved','paid')
              AND period_year = EXTRACT(YEAR FROM current_date)::int`,
          [orgId],
        ),
      ]);

      return {
        data: rows,
        meta: {
          ...page.meta(total.n),
          ytd_net: ytd.net,
          ytd_gross: ytd.gross,
          ytd_employer_cost: ytd.employer,
          ytd_runs: ytd.runs,
        },
      };
    },
  );

  // ═════════════════════════════════════════════════════════════════ CREATE
  app.post(
    '/payroll/runs',
    {
      preHandler: [app.loadContext, requirePermission('payroll.runs.create')],
      schema: { body: body({ year: v.int(2000, 2100), month: v.int(1, 12), notes: v.text(400) }, []) },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      await ensurePayrollSetup(db, orgId);

      // Default to last month: payroll for a month is run once it has ended.
      const now = new Date();
      const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const period = periodFor(
        request.body.year ?? previous.getFullYear(),
        request.body.month ?? previous.getMonth() + 1,
      );

      const existing = await db.one(
        `SELECT id, status FROM payroll_runs
          WHERE org_id = $1 AND period_year = $2 AND period_month = $3 AND status <> 'cancelled'`,
        [orgId, period.year, period.month],
      );
      if (existing) {
        throw conflict(`${period.label} has already been run.`, { run_id: existing.id, status: existing.status });
      }

      const run = await db.one(
        `INSERT INTO payroll_runs
           (id, org_id, period_year, period_month, period_start, period_end, label,
            attendance_from, attendance_to, notes, created_by)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$5::date,$6::date,$8,$9) RETURNING *`,
        [
          id('run'), orgId, period.year, period.month,
          period.start, period.end, period.label, request.body.notes ?? null, userId,
        ],
      );

      return reply.status(201).send({ data: run });
    },
  );

  // ════════════════════════════════════════════════════════════════ PROCESS
  /**
   * Compute every payslip in the run.
   *
   * Idempotent: processing twice replaces the payslips rather than doubling
   * them, so a run can be re-processed after a salary correction or a late
   * attendance fix. The whole thing is one transaction — a half-computed
   * payroll is worse than none.
   */
  app.post(
    '/payroll/runs/:runId/process',
    {
      preHandler: [app.loadContext, requirePermission('payroll.runs.create')],
      schema: {
        params: params({ runId: v.id('run') }),
        body: body({ employee_ids: { type: 'array', items: v.id('emp'), maxItems: 2000 } }, []),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const settings = await ensurePayrollSetup(db, orgId);

      const run = await db.one(
        `SELECT * FROM payroll_runs WHERE id = $1 AND org_id = $2`,
        [request.params.runId, orgId],
      );
      if (!run) throw notFound('Payroll run');
      if (run.status === 'paid') throw badRequest('This run has already been paid. Create a new run for corrections.');
      if (run.status === 'cancelled') throw badRequest('This run was cancelled.');

      const period = periodFor(run.period_year, run.period_month);

      // ── read HR, once, for the whole run ────────────────────────────────
      const employees = await hr.employees(orgId, { activeOn: period.end });

      if (!employees.length) {
        // "Nobody to pay" is nearly always "nobody had joined yet", and saying
        // so is the difference between a dead end and an obvious fix.
        const anyone = await hr.employees(orgId).catch(() => []);
        throw badRequest(
          anyone.length
            ? `Nobody was employed during ${period.label}. ${anyone.length === 1 ? 'The one person' : `All ${anyone.length} people`} on your roster joined after ${period.end}.`
            : 'There are no employees to pay. Add people in HR first.',
          { headcount_now: anyone.length, period: period.label },
        );
      }

      const wanted = request.body.employee_ids?.length
        ? employees.filter((e) => request.body.employee_ids.includes(e.id))
        : employees;

      const attendanceRows = await hr
        .attendance(orgId, { from: period.start, to: period.end })
        .catch((error) => {
          // A missing attendance service must not silently pay everyone a full
          // month without saying so — the flag travels onto every payslip.
          request.log.warn({ err: error }, 'attendance unavailable; paying full months');
          return [];
        });
      const attendanceBy = new Map(attendanceRows.map((a) => [a.employee_id, a]));

      // ── read this service's own tables ──────────────────────────────────
      const salaries = await db.rows(
        `SELECT DISTINCT ON (employee_id) *
           FROM employee_salaries
          WHERE org_id = $1
            AND effective_from <= $2::date
            AND (effective_to IS NULL OR effective_to >= $2::date)
          ORDER BY employee_id, effective_from DESC`,
        [orgId, period.end],
      );
      const salaryBy = new Map(salaries.map((s) => [s.employee_id, s]));

      const componentCache = new Map();
      const loadComponents = async (structureId) => {
        if (!componentCache.has(structureId)) {
          componentCache.set(structureId, await structureComponents(db, orgId, structureId));
        }
        return componentCache.get(structureId);
      };

      // Tax already deducted this financial year, so the projection settles
      // rather than restarting every month.
      const fy = fiscalYear(period.year, period.month);
      const paidTax = await db.rows(
        `SELECT p.employee_id, COALESCE(sum(l.amount),0) AS paid
           FROM payslip_lines l
           JOIN payslips p ON p.id = l.payslip_id
           JOIN payroll_runs r ON r.id = p.run_id
          WHERE l.org_id = $1 AND l.code = 'TDS' AND r.status <> 'cancelled'
            AND r.id <> $2
            AND ((r.period_year = $3 AND r.period_month >= 4)
              OR (r.period_year = $4 AND r.period_month <= 3))
          GROUP BY p.employee_id`,
        [orgId, run.id, Number(fy.slice(0, 4)), Number(fy.slice(0, 4)) + 1],
      );
      const taxPaidBy = new Map(paidTax.map((r) => [r.employee_id, toPaise(r.paid)]));

      // ── compute ─────────────────────────────────────────────────────────
      const slips = [];
      const skipped = [];

      for (const employee of wanted) {
        const salary = salaryBy.get(employee.id);
        if (!salary) {
          skipped.push({ employee_id: employee.id, name: employee.name, reason: 'No salary on record' });
          continue;
        }
        if (!salary.structure_id) {
          skipped.push({ employee_id: employee.id, name: employee.name, reason: 'No salary structure' });
          continue;
        }

        const components = await loadComponents(salary.structure_id);
        if (!components.length) {
          skipped.push({ employee_id: employee.id, name: employee.name, reason: 'Salary structure is empty' });
          continue;
        }

        slips.push(
          buildPayslip({
            employee,
            salary,
            components,
            attendance: attendanceBy.get(employee.id) ?? null,
            settings,
            period,
            ytdTaxPaidPaise: taxPaidBy.get(employee.id) ?? 0,
          }),
        );
      }

      if (!slips.length) {
        throw badRequest('Nobody in this run has a salary on record yet.', { skipped });
      }

      // ── write ───────────────────────────────────────────────────────────
      const totals = await db.transaction(async (tx) => {
        // Re-processing replaces the previous result entirely; the cascade
        // takes the lines with the payslips.
        await tx.query(`DELETE FROM payslips WHERE run_id = $1 AND org_id = $2`, [run.id, orgId]);

        for (const slip of slips) {
          const salary = salaryBy.get(slip.employee_id);
          const number = await nextPayslipNumber(tx, orgId, {
            prefix: settings.payslip_prefix,
            fiscalYear: fy,
          });

          const payslip = await tx.one(
            `INSERT INTO payslips
               (id, org_id, run_id, employee_id, payslip_number,
                employee_name, employee_code, designation, department_name, joined_on,
                pan, uan, esi_number, bank_account, bank_name,
                days_in_period, payable_days, lop_days, leave_days, overtime_hours,
                monthly_gross, gross_earnings, total_deductions, net_pay,
                employer_contrib, ctc_for_period, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12,$13,$14,$15,
                     $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
             RETURNING id`,
            [
              id('psl'), orgId, run.id, slip.employee_id, number,
              slip.employee_name, slip.employee_code, slip.designation,
              slip.department_name, slip.joined_on,
              salary.pan, salary.uan, salary.esi_number, salary.bank_account, salary.bank_name,
              slip.days_in_period, slip.payable_days, slip.lop_days, slip.leave_days, slip.overtime_hours,
              toRupees(slip.monthly_gross), toRupees(slip.gross_earnings),
              toRupees(slip.total_deductions), toRupees(slip.net_pay),
              toRupees(slip.employer_contrib), toRupees(slip.ctc_for_period),
              slip.attendance_assumed ? 'No attendance was recorded for this period; a full month was paid.' : null,
            ],
          );

          for (const [index, line] of slip.lines.entries()) {
            await tx.query(
              `INSERT INTO payslip_lines (id, org_id, payslip_id, code, name, kind, amount, basis, position)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                id('psi'), orgId, payslip.id, line.code, line.name, line.kind,
                toRupees(line.amount), line.basis ?? null, line.position ?? index,
              ],
            );
          }
        }

        const sums = slips.reduce(
          (acc, s) => ({
            gross: acc.gross + s.gross_earnings,
            deductions: acc.deductions + s.total_deductions,
            net: acc.net + s.net_pay,
            employer: acc.employer + s.employer_contrib,
          }),
          { gross: 0, deductions: 0, net: 0, employer: 0 },
        );

        await tx.query(
          `UPDATE payroll_runs
              SET status = CASE WHEN status = 'draft' THEN 'review' ELSE status END,
                  headcount = $3, gross_total = $4, deduction_total = $5,
                  net_total = $6, employer_cost = $7,
                  processed_by = $8, processed_at = now()
            WHERE id = $1 AND org_id = $2`,
          [
            run.id, orgId, slips.length,
            toRupees(sums.gross), toRupees(sums.deductions),
            toRupees(sums.net), toRupees(sums.gross + sums.employer),
            userId,
          ],
        );

        tx.emit({
          type: EVENTS.PAYROLL_PROCESSED,
          org_id: orgId,
          actor_id: userId,
          data: {
            run_id: run.id,
            period: period.label,
            headcount: slips.length,
            net_total: toRupees(sums.net),
            gross_total: toRupees(sums.gross),
          },
        });

        return sums;
      });

      const updated = await db.one(`SELECT * FROM payroll_runs WHERE id = $1`, [run.id]);

      return {
        data: updated,
        meta: {
          processed: slips.length,
          skipped,
          attendance_missing: slips.filter((s) => s.attendance_assumed).length,
          totals: {
            gross: toRupees(totals.gross),
            deductions: toRupees(totals.deductions),
            net: toRupees(totals.net),
            employer_contribution: toRupees(totals.employer),
          },
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════════ DETAIL
  app.get(
    '/payroll/runs/:runId',
    {
      preHandler: [app.loadContext, requirePermission('payroll.runs.view')],
      schema: { params: params({ runId: v.id('run') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const run = await db.one(`SELECT * FROM payroll_runs WHERE id = $1 AND org_id = $2`, [request.params.runId, orgId]);
      if (!run) throw notFound('Payroll run');

      const payslips = await db.rows(
        `SELECT id, employee_id, payslip_number, employee_name, employee_code, designation,
                department_name, payable_days, lop_days, overtime_hours,
                gross_earnings, total_deductions, net_pay, employer_contrib, status, notes
           FROM payslips WHERE run_id = $1 AND org_id = $2
          ORDER BY employee_code NULLS LAST, employee_name`,
        [run.id, orgId],
      );

      // A statutory summary is what actually gets filed, so it is computed
      // from the stored lines rather than re-derived.
      const statutory = await db.rows(
        `SELECT l.code, l.name, l.kind, sum(l.amount) AS total, count(*)::int AS people
           FROM payslip_lines l JOIN payslips p ON p.id = l.payslip_id
          WHERE p.run_id = $1 AND l.org_id = $2 AND l.kind <> 'earning'
          GROUP BY l.code, l.name, l.kind ORDER BY l.kind, l.code`,
        [run.id, orgId],
      );

      const earnings = await db.rows(
        `SELECT l.code, l.name, sum(l.amount) AS total
           FROM payslip_lines l JOIN payslips p ON p.id = l.payslip_id
          WHERE p.run_id = $1 AND l.org_id = $2 AND l.kind = 'earning'
          GROUP BY l.code, l.name ORDER BY sum(l.amount) DESC`,
        [run.id, orgId],
      );

      return {
        data: {
          ...run,
          payslips,
          earnings_breakdown: earnings,
          statutory_breakdown: statutory,
          next_statuses: NEXT_STATUS[run.status] ?? [],
        },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════ TRANSITION
  app.post(
    '/payroll/runs/:runId/status',
    {
      preHandler: [app.loadContext, requirePermission('payroll.runs.approve')],
      schema: {
        params: params({ runId: v.id('run') }),
        body: body({ status: v.enum(['draft', 'review', 'approved', 'paid', 'cancelled']), note: v.text(300) }, ['status']),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const target = request.body.status;

      const run = await db.one(`SELECT * FROM payroll_runs WHERE id = $1 AND org_id = $2`, [request.params.runId, orgId]);
      if (!run) throw notFound('Payroll run');

      const allowed = NEXT_STATUS[run.status] ?? [];
      if (!allowed.includes(target)) {
        throw badRequest(
          allowed.length
            ? `A ${run.status} run can only move to: ${allowed.join(', ')}.`
            : `A ${run.status} run cannot be changed.`,
          { from: run.status, allowed },
        );
      }

      if (target === 'approved' && !run.processed_at) {
        throw badRequest('Process the run before approving it.');
      }

      const updated = await db.transaction(async (tx) => {
        const row = await tx.one(
          `UPDATE payroll_runs
              SET status = $3,
                  approved_by = CASE WHEN $3 = 'approved' THEN $4 ELSE approved_by END,
                  approved_at = CASE WHEN $3 = 'approved' THEN now() ELSE approved_at END,
                  paid_at = CASE WHEN $3 = 'paid' THEN now() ELSE paid_at END,
                  notes = COALESCE($5, notes)
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [run.id, orgId, target, userId, request.body.note ?? null],
        );

        // Payslips follow the run, so an employee never sees an approved
        // payslip inside a run that is still under review.
        if (target === 'approved' || target === 'paid') {
          await tx.query(
            `UPDATE payslips SET status = $3 WHERE run_id = $1 AND org_id = $2 AND status <> 'held'`,
            [run.id, orgId, target],
          );
        }
        if (target === 'review' || target === 'draft') {
          await tx.query(
            `UPDATE payslips SET status = 'draft' WHERE run_id = $1 AND org_id = $2 AND status <> 'held'`,
            [run.id, orgId],
          );
        }

        // Only the states another app would act on are published. `draft` and
        // `review` are internal bookkeeping and nobody subscribes to them.
        const topic = {
          approved: EVENTS.PAYROLL_APPROVED,
          paid: EVENTS.PAYROLL_PAID,
          cancelled: EVENTS.PAYROLL_CANCELLED,
        }[target];

        if (topic) {
          tx.emit({
            type: topic,
            org_id: orgId,
            actor_id: userId,
            data: {
              run_id: run.id,
              period: run.label,
              period_year: run.period_year,
              period_month: run.period_month,
              net_total: row.net_total,
              employer_cost: row.employer_cost,
              headcount: row.headcount,
            },
          });
        }

        return row;
      });

      return { data: updated };
    },
  );

  // ══════════════════════════════════════════════════════════════ BANK FILE
  /**
   * The payment advice a bank actually takes: one row per payslip, net amount,
   * account and IFSC. Held payslips are excluded — that is what holding means.
   */
  app.get(
    '/payroll/runs/:runId/bank-advice',
    {
      preHandler: [app.loadContext, requirePermission('payroll.runs.approve')],
      schema: { params: params({ runId: v.id('run') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const run = await db.one(`SELECT * FROM payroll_runs WHERE id = $1 AND org_id = $2`, [request.params.runId, orgId]);
      if (!run) throw notFound('Payroll run');
      if (!['approved', 'paid'].includes(run.status)) {
        throw badRequest('Approve the run before generating a bank advice.');
      }

      const rows = await db.rows(
        `SELECT p.payslip_number, p.employee_name, p.employee_code, p.net_pay,
                p.bank_account, p.bank_name, p.status,
                es.bank_ifsc, es.payment_mode
           FROM payslips p
           LEFT JOIN employee_salaries es
             ON es.org_id = p.org_id AND es.employee_id = p.employee_id AND es.effective_to IS NULL
          WHERE p.run_id = $1 AND p.org_id = $2 AND p.status <> 'held'
          ORDER BY p.employee_code NULLS LAST`,
        [run.id, orgId],
      );

      const payable = rows.filter((r) => r.bank_account && r.payment_mode === 'bank');
      const unbanked = rows.filter((r) => !r.bank_account || r.payment_mode !== 'bank');

      const total = payable.reduce((sum, r) => sum + toPaise(r.net_pay), 0);

      return {
        data: payable,
        meta: {
          run: run.label,
          count: payable.length,
          total: toRupees(total),
          // Named, not silently dropped: somebody has to pay these people too.
          excluded: unbanked.map((r) => ({
            name: r.employee_name,
            reason: r.bank_account ? `paid by ${r.payment_mode}` : 'no bank account on record',
            net_pay: r.net_pay,
          })),
        },
      };
    },
  );
}
