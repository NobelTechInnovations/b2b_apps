import { paginate } from '@nexus/db-kit';
import {
  requirePermission, body, params, query, validate as v, notFound, badRequest, forbidden,
} from '@nexus/service-kit';
import { toPaise, toRupees } from '../lib/money.js';
import { ensurePayrollSetup } from '../lib/setup.js';

const inr = (value) =>
  `₹${Number(value ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Words for an amount, because that is what a payslip is expected to carry. */
function amountInWords(rupees) {
  const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  const under100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);
  const under1000 = (n) =>
    n < 100 ? under100(n) : `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${under100(n % 100)}` : ''}`;

  const whole = Math.floor(Math.abs(Number(rupees) || 0));
  const paise = Math.round((Math.abs(Number(rupees) || 0) - whole) * 100);
  if (whole === 0 && paise === 0) return 'Zero rupees only';

  // Indian grouping: crore, lakh, thousand, hundred.
  const parts = [];
  const units = [
    [10_000_000, 'crore'],
    [100_000, 'lakh'],
    [1000, 'thousand'],
  ];

  let rest = whole;
  for (const [value, name] of units) {
    const count = Math.floor(rest / value);
    if (count) { parts.push(`${under1000(count)} ${name}`); rest %= value; }
  }
  if (rest) parts.push(under1000(rest));

  const rupeeWords = parts.join(' ').trim();
  const head = rupeeWords ? `${rupeeWords} rupee${whole === 1 ? '' : 's'}` : '';
  const tail = paise ? `${head ? ' and ' : ''}${under100(paise)} paise` : '';

  const sentence = `${head}${tail} only`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export async function payslipRoutes(app) {
  const { db, workspace, hr } = app;

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/payroll/payslips',
    {
      preHandler: [app.loadContext, requirePermission('payroll.payslips.view')],
      schema: {
        querystring: query({
          employee_id: v.id('emp'),
          run_id: v.id('run'),
          year: v.int(2000, 2100),
          month: v.int(1, 12),
          status: v.enum(['draft', 'approved', 'paid', 'held']),
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      await ensurePayrollSetup(db, orgId);

      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'net_pay'] });
      const qs = request.query;

      const where = ['p.org_id = $1'];
      const values = [orgId];
      if (qs.employee_id) { values.push(qs.employee_id); where.push(`p.employee_id = $${values.length}`); }
      if (qs.run_id) { values.push(qs.run_id); where.push(`p.run_id = $${values.length}`); }
      if (qs.status) { values.push(qs.status); where.push(`p.status = $${values.length}`); }
      if (qs.year) { values.push(qs.year); where.push(`r.period_year = $${values.length}`); }
      if (qs.month) { values.push(qs.month); where.push(`r.period_month = $${values.length}`); }
      if (qs.q) {
        values.push(`%${qs.q}%`);
        where.push(`(p.employee_name ILIKE $${values.length} OR p.employee_code ILIKE $${values.length} OR p.payslip_number ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');
      const join = `FROM payslips p JOIN payroll_runs r ON r.id = p.run_id`;

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT p.*, r.label, r.period_year, r.period_month, r.status AS run_status ${join}
            WHERE ${clause}
            ORDER BY r.period_year DESC, r.period_month DESC, p.employee_code NULLS LAST
            LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n ${join} WHERE ${clause}`, values),
      ]);

      const netTotal = rows.reduce((sum, r) => sum + toPaise(r.net_pay), 0);

      return { data: rows, meta: { ...page.meta(total.n), page_net_total: toRupees(netTotal) } };
    },
  );

  // ═════════════════════════════════════════════════════════════════ DETAIL
  /** Everything a printable payslip needs, in one read. */
  app.get(
    '/payroll/payslips/:payslipId',
    {
      preHandler: [app.loadContext, requirePermission('payroll.payslips.view')],
      schema: { params: params({ payslipId: v.id('psl') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const [settings, org] = await Promise.all([
        ensurePayrollSetup(db, orgId),
        workspace.forOrg(orgId),
      ]);

      const payslip = await db.one(
        `SELECT p.*, r.label, r.period_start, r.period_end, r.period_year, r.period_month,
                r.status AS run_status, r.paid_at
           FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
          WHERE p.id = $1 AND p.org_id = $2`,
        [request.params.payslipId, orgId],
      );
      if (!payslip) throw notFound('Payslip');

      const lines = await db.rows(
        `SELECT code, name, kind, amount, basis, position FROM payslip_lines
          WHERE payslip_id = $1 AND org_id = $2 ORDER BY kind, position`,
        [payslip.id, orgId],
      );

      // Year-to-date, for the box every payslip carries in the corner.
      const ytd = await db.one(
        `SELECT COALESCE(sum(p.gross_earnings),0) AS gross,
                COALESCE(sum(p.total_deductions),0) AS deductions,
                COALESCE(sum(p.net_pay),0) AS net,
                count(*)::int AS months
           FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
          WHERE p.org_id = $1 AND p.employee_id = $2 AND r.status <> 'cancelled'
            AND ((r.period_year = $3 AND r.period_month >= 4)
              OR (r.period_year = $4 AND r.period_month <= 3))`,
        [
          orgId, payslip.employee_id,
          payslip.period_month >= 4 ? payslip.period_year : payslip.period_year - 1,
          payslip.period_month >= 4 ? payslip.period_year + 1 : payslip.period_year,
        ],
      );

      return {
        data: {
          ...payslip,
          net_pay_words: amountInWords(payslip.net_pay),
          earnings: lines.filter((l) => l.kind === 'earning'),
          deductions: lines.filter((l) => l.kind === 'deduction'),
          employer: lines.filter((l) => l.kind === 'employer'),
          employer_details: {
            // Typed into payroll settings, else the workspace's own name.
            name: settings.employer_name || org.name,
            address: settings.employer_address,
            pan: settings.employer_pan,
            tan: settings.employer_tan,
            pf_establishment: settings.pf_establishment,
            esi_establishment: settings.esi_establishment,
          },
          ytd,
          currency: settings.currency,
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════════════ HOLD
  /**
   * Hold a payslip out of a run without unwinding the whole run — the usual
   * reason being a bank detail that has not been confirmed yet.
   */
  app.post(
    '/payroll/payslips/:payslipId/hold',
    {
      preHandler: [app.loadContext, requirePermission('payroll.runs.approve')],
      schema: {
        params: params({ payslipId: v.id('psl') }),
        body: body({ reason: v.text(300), release: v.bool }, []),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const payslip = await db.one(
        `SELECT p.*, r.status AS run_status FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
          WHERE p.id = $1 AND p.org_id = $2`,
        [request.params.payslipId, orgId],
      );
      if (!payslip) throw notFound('Payslip');
      if (payslip.run_status === 'paid') throw badRequest('This run has already been paid.');

      const release = request.body.release ?? false;
      const status = release
        ? (payslip.run_status === 'approved' ? 'approved' : 'draft')
        : 'held';

      const updated = await db.one(
        `UPDATE payslips SET status = $3, hold_reason = $4 WHERE id = $1 AND org_id = $2 RETURNING *`,
        [payslip.id, orgId, status, release ? null : (request.body.reason ?? 'Held for review')],
      );

      return { data: updated };
    },
  );

  // ════════════════════════════════════════════════════════════════ REGISTER
  /**
   * The salary register: one row per person, one column per component, for a
   * whole run. This is the sheet finance reconciles against, so components are
   * pivoted dynamically — a workspace that invented a "Site allowance" gets a
   * Site allowance column without anybody editing a report.
   */
  app.get(
    '/payroll/runs/:runId/register',
    {
      preHandler: [app.loadContext, requirePermission('payroll.reports.view')],
      schema: { params: params({ runId: v.id('run') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const run = await db.one(`SELECT * FROM payroll_runs WHERE id = $1 AND org_id = $2`, [request.params.runId, orgId]);
      if (!run) throw notFound('Payroll run');

      const rows = await db.rows(
        `SELECT p.id, p.payslip_number, p.employee_name, p.employee_code, p.designation,
                p.department_name, p.payable_days, p.lop_days, p.overtime_hours,
                p.gross_earnings, p.total_deductions, p.net_pay, p.employer_contrib, p.status,
                p.pan, p.uan, p.bank_account,
                l.code, l.name AS line_name, l.kind, l.amount
           FROM payslips p
           LEFT JOIN payslip_lines l ON l.payslip_id = p.id
          WHERE p.run_id = $1 AND p.org_id = $2
          ORDER BY p.employee_code NULLS LAST, p.employee_name, l.kind, l.position`,
        [run.id, orgId],
      );

      const byPayslip = new Map();
      const columns = { earning: new Map(), deduction: new Map(), employer: new Map() };

      for (const row of rows) {
        if (!byPayslip.has(row.id)) {
          byPayslip.set(row.id, {
            payslip_id: row.id,
            payslip_number: row.payslip_number,
            employee_name: row.employee_name,
            employee_code: row.employee_code,
            designation: row.designation,
            department_name: row.department_name,
            pan: row.pan,
            uan: row.uan,
            bank_account: row.bank_account,
            payable_days: row.payable_days,
            lop_days: row.lop_days,
            overtime_hours: row.overtime_hours,
            gross_earnings: row.gross_earnings,
            total_deductions: row.total_deductions,
            net_pay: row.net_pay,
            employer_contrib: row.employer_contrib,
            status: row.status,
            components: {},
          });
        }
        if (row.code) {
          byPayslip.get(row.id).components[row.code] = row.amount;
          columns[row.kind]?.set(row.code, row.line_name);
        }
      }

      const asColumns = (map) => [...map.entries()].map(([code, name]) => ({ code, name }));

      const data = [...byPayslip.values()];
      const totals = data.reduce(
        (acc, r) => ({
          gross: acc.gross + toPaise(r.gross_earnings),
          deductions: acc.deductions + toPaise(r.total_deductions),
          net: acc.net + toPaise(r.net_pay),
          employer: acc.employer + toPaise(r.employer_contrib),
        }),
        { gross: 0, deductions: 0, net: 0, employer: 0 },
      );

      // Column totals too — a register without them cannot be tied out.
      const componentTotals = {};
      for (const row of data) {
        for (const [code, amount] of Object.entries(row.components)) {
          componentTotals[code] = (componentTotals[code] ?? 0) + toPaise(amount);
        }
      }

      return {
        data,
        meta: {
          run: { id: run.id, label: run.label, status: run.status, period_start: run.period_start, period_end: run.period_end },
          columns: {
            earnings: asColumns(columns.earning),
            deductions: asColumns(columns.deduction),
            employer: asColumns(columns.employer),
          },
          component_totals: Object.fromEntries(
            Object.entries(componentTotals).map(([code, paise]) => [code, toRupees(paise)]),
          ),
          totals: {
            gross: toRupees(totals.gross),
            deductions: toRupees(totals.deductions),
            net: toRupees(totals.net),
            employer_contribution: toRupees(totals.employer),
            headcount: data.length,
          },
        },
      };
    },
  );

  // ═══════════════════════════════════════════════════════════════ STATUTORY
  /**
   * PF and ESI returns for a period. Filed monthly, so the shape follows the
   * ECR rather than anything of our own invention.
   */
  app.get(
    '/payroll/reports/statutory',
    {
      preHandler: [app.loadContext, requirePermission('payroll.reports.view')],
      schema: { querystring: query({ year: v.int(2000, 2100), month: v.int(1, 12), run_id: v.id('run') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const settings = await ensurePayrollSetup(db, orgId);

      const values = [orgId];
      const where = ["p.org_id = $1", "r.status IN ('approved','paid')"];
      if (request.query.run_id) { values.push(request.query.run_id); where.push(`r.id = $${values.length}`); }
      if (request.query.year) { values.push(request.query.year); where.push(`r.period_year = $${values.length}`); }
      if (request.query.month) { values.push(request.query.month); where.push(`r.period_month = $${values.length}`); }

      const clause = where.join(' AND ');

      const rows = await db.rows(
        `SELECT p.employee_name, p.employee_code, p.uan, p.esi_number, p.pan,
                p.gross_earnings, p.payable_days,
                COALESCE(max(l.amount) FILTER (WHERE l.code = 'PF'), 0)     AS pf_employee,
                COALESCE(max(l.amount) FILTER (WHERE l.code = 'PF_ER'), 0)  AS pf_employer,
                COALESCE(max(l.amount) FILTER (WHERE l.code = 'EPS'), 0)    AS eps,
                COALESCE(max(l.amount) FILTER (WHERE l.code = 'ESI'), 0)    AS esi_employee,
                COALESCE(max(l.amount) FILTER (WHERE l.code = 'ESI_ER'), 0) AS esi_employer,
                COALESCE(max(l.amount) FILTER (WHERE l.code = 'PT'), 0)     AS professional_tax,
                COALESCE(max(l.amount) FILTER (WHERE l.code = 'TDS'), 0)    AS tds
           FROM payslips p
           JOIN payroll_runs r ON r.id = p.run_id
           LEFT JOIN payslip_lines l ON l.payslip_id = p.id
          WHERE ${clause}
          GROUP BY p.id, p.employee_name, p.employee_code, p.uan, p.esi_number, p.pan,
                   p.gross_earnings, p.payable_days
          ORDER BY p.employee_code NULLS LAST`,
        values,
      );

      const sum = (key) => toRupees(rows.reduce((total, r) => total + toPaise(r[key]), 0));

      return {
        data: rows,
        meta: {
          headcount: rows.length,
          pf: {
            establishment: settings.pf_establishment,
            employee: sum('pf_employee'),
            employer: sum('pf_employer'),
            pension: sum('eps'),
            total: toRupees(
              rows.reduce((t, r) => t + toPaise(r.pf_employee) + toPaise(r.pf_employer) + toPaise(r.eps), 0),
            ),
            contributing: rows.filter((r) => toPaise(r.pf_employee) > 0).length,
          },
          esi: {
            establishment: settings.esi_establishment,
            employee: sum('esi_employee'),
            employer: sum('esi_employer'),
            total: toRupees(rows.reduce((t, r) => t + toPaise(r.esi_employee) + toPaise(r.esi_employer), 0)),
            contributing: rows.filter((r) => toPaise(r.esi_employee) > 0).length,
          },
          professional_tax: { state: settings.pt_state, total: sum('professional_tax') },
          tds: { tan: settings.employer_tan, regime: settings.tds_regime, total: sum('tds') },
        },
      };
    },
  );

  // ══════════════════════════════════════════════════════════ MY PAYSLIPS
  /**
   * The employee's own payslips.
   *
   * Resolves the person from the signed-in user via HR — payroll keeps no copy
   * of that mapping — and never takes an employee id, so there is nothing to
   * tamper with.
   *
   * Only APPROVED and PAID runs are visible. A draft payslip is working
   * material: showing somebody a figure that is still being calibrated, and
   * then changing it, is worse than showing nothing.
   */
  async function meFor(request) {
    const { orgId, userId } = request.ctx;

    const employee = await hr.employeeForUser(orgId, userId).catch((error) => {
      request.log.error({ err: error }, 'could not resolve the signed-in user to an employee');
      return null;
    });

    if (!employee?.id) {
      throw forbidden('Your login is not linked to an employee record in this workspace.', {
        code: 'no_employee_record',
      });
    }

    return employee;
  }

  app.get(
    '/payroll/me/payslips',
    { preHandler: [app.loadContext, requirePermission('payroll.self.payslips')] },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await meFor(request);

      const rows = await db.rows(
        `SELECT p.id, p.payslip_number, p.payable_days, p.lop_days, p.overtime_hours,
                p.gross_earnings, p.total_deductions, p.net_pay, p.status,
                r.label, r.period_year, r.period_month, r.period_start, r.period_end,
                r.status AS run_status, r.paid_at
           FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
          WHERE p.org_id = $1 AND p.employee_id = $2
            AND r.status IN ('approved','paid')
          ORDER BY r.period_year DESC, r.period_month DESC`,
        [orgId, employee.id],
      );

      const ytd = await db.one(
        `SELECT COALESCE(sum(p.gross_earnings),0) AS gross,
                COALESCE(sum(p.total_deductions),0) AS deductions,
                COALESCE(sum(p.net_pay),0) AS net,
                count(*)::int AS months
           FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
          WHERE p.org_id = $1 AND p.employee_id = $2
            AND r.status IN ('approved','paid')
            AND ((r.period_year = $3 AND r.period_month >= 4)
              OR (r.period_year = $4 AND r.period_month <= 3))`,
        [
          orgId, employee.id,
          new Date().getMonth() + 1 >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1,
          new Date().getMonth() + 1 >= 4 ? new Date().getFullYear() + 1 : new Date().getFullYear(),
        ],
      );

      return { data: rows, meta: { total: rows.length, ytd, employee } };
    },
  );

  app.get(
    '/payroll/me/payslips/:payslipId',
    {
      preHandler: [app.loadContext, requirePermission('payroll.self.payslips')],
      schema: { params: params({ payslipId: v.id('psl') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const employee = await meFor(request);
      const [settings, org] = await Promise.all([
        ensurePayrollSetup(db, orgId),
        workspace.forOrg(orgId),
      ]);

      // The employee id in the WHERE clause is the resolved one, never the
      // caller's — a payslip id from a colleague simply does not match.
      const payslip = await db.one(
        `SELECT p.*, r.label, r.period_start, r.period_end, r.period_year, r.period_month,
                r.status AS run_status, r.paid_at
           FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
          WHERE p.id = $1 AND p.org_id = $2 AND p.employee_id = $3
            AND r.status IN ('approved','paid')`,
        [request.params.payslipId, orgId, employee.id],
      );
      if (!payslip) throw notFound('Payslip');

      const lines = await db.rows(
        `SELECT code, name, kind, amount, basis, position FROM payslip_lines
          WHERE payslip_id = $1 AND org_id = $2 ORDER BY kind, position`,
        [payslip.id, orgId],
      );

      return {
        data: {
          ...payslip,
          net_pay_words: amountInWords(payslip.net_pay),
          earnings: lines.filter((l) => l.kind === 'earning'),
          deductions: lines.filter((l) => l.kind === 'deduction'),
          employer: lines.filter((l) => l.kind === 'employer'),
          employer_details: {
            name: settings.employer_name || org.name,
            address: settings.employer_address,
            pan: settings.employer_pan,
            tan: settings.employer_tan,
            pf_establishment: settings.pf_establishment,
            esi_establishment: settings.esi_establishment,
          },
          currency: settings.currency,
        },
      };
    },
  );

  // ═════════════════════════════════════════════════════════════════ OVERVIEW
  app.get(
    '/payroll',
    { preHandler: [app.loadContext, requirePermission('payroll.runs.view')] },
    async (request) => {
      const { orgId } = request.ctx;
      await ensurePayrollSetup(db, orgId);

      const [latest, onPayroll, unpaid, trend] = await Promise.all([
        db.one(
          `SELECT * FROM payroll_runs WHERE org_id = $1 AND status <> 'cancelled'
            ORDER BY period_year DESC, period_month DESC LIMIT 1`,
          [orgId],
        ),
        db.one(
          `SELECT count(*)::int AS n, COALESCE(sum(monthly_gross),0) AS monthly
             FROM employee_salaries WHERE org_id = $1 AND effective_to IS NULL`,
          [orgId],
        ),
        db.one(
          `SELECT count(*)::int AS n FROM payroll_runs
            WHERE org_id = $1 AND status IN ('draft','review','approved')`,
          [orgId],
        ),
        db.rows(
          `SELECT period_year, period_month, label, net_total, gross_total, employer_cost, headcount
             FROM payroll_runs
            WHERE org_id = $1 AND status IN ('approved','paid')
            ORDER BY period_year DESC, period_month DESC LIMIT 12`,
          [orgId],
        ),
      ]);

      const missing = await db.one(
        `SELECT count(*)::int AS n FROM payslips p
           JOIN payroll_runs r ON r.id = p.run_id
          WHERE p.org_id = $1 AND p.status = 'held'
            AND r.status IN ('draft','review','approved')`,
        [orgId],
      );

      return {
        data: {
          latest_run: latest,
          on_payroll: onPayroll.n,
          monthly_commitment: onPayroll.monthly,
          annual_commitment: toRupees(toPaise(onPayroll.monthly) * 12),
          open_runs: unpaid.n,
          held_payslips: missing.n,
          trend: [...trend].reverse(),
        },
      };
    },
  );
}
