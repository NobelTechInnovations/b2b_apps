/**
 * The payslip engine.
 *
 * One pure function turns (salary, structure, attendance, settings) into a
 * complete payslip with every line's working written out. It touches no
 * database and makes no network call, so it can be unit-tested, previewed
 * before a run is committed, and re-run to reproduce an old payslip exactly.
 */
import { toPaise, toRupees, percentOf } from './money.js';
import {
  providentFund, employeeStateInsurance, professionalTax, monthlyTDS, monthsLeftInFY,
} from './statutory.js';

const inr = (paise) =>
  `₹${Number(toRupees(paise)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

/**
 * Components are computed in dependency order, not in display order.
 *
 * Basic must exist before anything can be a percentage of it, and the balance
 * component must be last because it absorbs whatever is left. Sorting here
 * rather than trusting the editor means a badly ordered structure still
 * produces a correct payslip.
 */
const STAGE = { percent_of_gross: 0, percent_of_ctc: 0, fixed: 1, percent_of_basic: 2, balance: 3, statutory: 4 };

export function resolveEarnings({ components, monthlyGrossPaise, annualCtcPaise }) {
  const earnings = components
    .filter((c) => c.kind === 'earning' && c.calculation !== 'statutory')
    .sort((a, b) => (STAGE[a.calculation] ?? 1) - (STAGE[b.calculation] ?? 1) || a.position - b.position);

  const monthlyCtc = Math.round((annualCtcPaise ?? 0) / 12);
  const resolved = [];
  let basic = 0;

  for (const component of earnings) {
    let amount = 0;
    let basis = null;

    switch (component.calculation) {
      case 'percent_of_gross':
        amount = percentOf(monthlyGrossPaise, Number(component.value));
        basis = `${Number(component.value)}% of gross ${inr(monthlyGrossPaise)}`;
        break;
      case 'percent_of_ctc':
        amount = percentOf(monthlyCtc, Number(component.value));
        basis = `${Number(component.value)}% of monthly CTC ${inr(monthlyCtc)}`;
        break;
      case 'percent_of_basic':
        amount = percentOf(basic, Number(component.value));
        basis = `${Number(component.value)}% of basic ${inr(basic)}`;
        break;
      case 'balance': {
        const assigned = resolved.reduce((sum, r) => sum + r.amount, 0);
        amount = Math.max(0, monthlyGrossPaise - assigned);
        basis = `gross ${inr(monthlyGrossPaise)} less ${inr(assigned)} already allocated`;
        break;
      }
      default:
        amount = toPaise(component.value);
        basis = 'fixed monthly amount';
    }

    // Everything downstream keys off basic, so remember it as soon as it lands.
    if (component.code?.toUpperCase() === 'BASIC') basic += amount;

    resolved.push({ ...component, amount, basis });
  }

  // Restore the order the structure declared, for display.
  resolved.sort((a, b) => a.position - b.position);

  return {
    lines: resolved,
    basic,
    total: resolved.reduce((sum, r) => sum + r.amount, 0),
  };
}

/**
 * Days that are actually paid.
 *
 * A month is divided by `days_basis`: by its own length (the common default),
 * by a fixed 26 (the older Indian convention, which pays the same daily rate
 * in February as in March), or by scheduled working days only.
 */
export function payableDays({ attendance, periodStart, periodEnd, settings }) {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  const calendarDays = Math.round((end - start) / 86_400_000) + 1;

  const basis = settings.days_basis === 'fixed_26'
    ? 26
    : settings.days_basis === 'working'
      ? Math.max(1, Math.round((attendance?.expected_minutes ?? 0) / 480)) || calendarDays
      : calendarDays;

  // No attendance at all means nobody marked the month. Paying a full month is
  // the only safe default: docking pay for missing data would be a wage theft
  // caused by a data-entry gap.
  if (!attendance) {
    return { days_in_period: basis, payable: basis, lop: 0, leave: 0, assumed: true };
  }

  const present = Number(attendance.days_present ?? 0);
  const half = Number(attendance.days_half ?? 0);
  const leave = Number(attendance.days_leave ?? 0);
  const absent = Number(attendance.days_absent ?? 0);

  const marked = present + half + leave + absent;
  // Days nobody marked at all — weekends, holidays, and genuine gaps. They are
  // paid: a weekend is not loss of pay.
  const unmarked = Math.max(0, basis - marked);

  const payable = Math.min(basis, present + half * 0.5 + leave + unmarked);
  const lop = Math.max(0, basis - payable);

  return {
    days_in_period: basis,
    payable: Math.round(payable * 100) / 100,
    lop: Math.round(lop * 100) / 100,
    leave,
    absent,
    half,
    present,
    assumed: false,
  };
}

/**
 * Overtime pay.
 *
 * Rate is the ordinary hourly rate — basic, over the month's paid days and a
 * standard eight-hour day — multiplied by the statutory factor, 2× by default.
 */
export function overtimePay({ basicPaise, hours, days, settings }) {
  if (!settings.overtime_enabled || !hours) return null;

  const hourly = Math.round(basicPaise / Math.max(1, days * 8));
  const multiplier = Number(settings.overtime_multiplier ?? 2);
  const amount = Math.round(hourly * hours * multiplier);
  if (amount <= 0) return null;

  return {
    amount,
    hours,
    hourly,
    multiplier,
    basis: `${hours}h × ${inr(hourly)}/h × ${multiplier}`,
  };
}

/**
 * Build one payslip.
 *
 * Returns paise throughout plus a `lines` array ready to insert. Nothing here
 * reads or writes; the caller decides whether to keep the result.
 */
export function buildPayslip({
  employee,
  salary,
  components,
  attendance,
  settings,
  period,
  ytdTaxPaidPaise = 0,
}) {
  const monthlyGross = toPaise(salary.monthly_gross);
  const annualCtc = toPaise(salary.annual_ctc);

  const days = payableDays({
    attendance,
    periodStart: period.start,
    periodEnd: period.end,
    settings,
  });

  const structure = resolveEarnings({ components, monthlyGrossPaise: monthlyGross, annualCtcPaise: annualCtc });

  // Proration. A full month is the common case and must not drift by a paisa,
  // so it short-circuits rather than multiplying by 30/30.
  const ratio = days.payable / days.days_in_period;
  const prorate = (paise) => (ratio >= 1 ? paise : Math.round(paise * ratio));

  const earningLines = structure.lines.map((line) => ({
    code: line.code,
    name: line.name,
    kind: 'earning',
    amount: prorate(line.amount),
    basis: ratio >= 1 ? line.basis : `${line.basis}, prorated ${days.payable}/${days.days_in_period} days`,
    position: line.position,
    pf_applicable: line.pf_applicable,
    esi_applicable: line.esi_applicable,
    taxable: line.taxable,
  }));

  const proratedBasic = prorate(structure.basic);

  // ── overtime ──────────────────────────────────────────────────────────
  const overtime = overtimePay({
    basicPaise: structure.basic,
    hours: Number(attendance?.overtime_hours ?? 0),
    days: days.days_in_period,
    settings,
  });

  if (overtime) {
    earningLines.push({
      code: 'OT',
      name: 'Overtime',
      kind: 'earning',
      amount: overtime.amount,
      basis: overtime.basis,
      position: 900,
      pf_applicable: false,
      // Overtime counts toward ESI wages; it does not count toward PF wages.
      esi_applicable: true,
      taxable: true,
    });
  }

  const grossEarnings = earningLines.reduce((sum, l) => sum + l.amount, 0);
  const pfWages = earningLines.filter((l) => l.pf_applicable).reduce((sum, l) => sum + l.amount, 0);
  const esiWages = earningLines.filter((l) => l.esi_applicable).reduce((sum, l) => sum + l.amount, 0);
  const taxableEarnings = earningLines.filter((l) => l.taxable).reduce((sum, l) => sum + l.amount, 0);

  // ── deductions ────────────────────────────────────────────────────────
  const deductionLines = [];
  const employerLines = [];

  const pf = providentFund(pfWages, settings);
  if (pf) {
    deductionLines.push({
      code: 'PF', name: 'Provident fund', kind: 'deduction', amount: pf.employee, position: 10,
      basis: `${Number(settings.pf_employee_rate)}% of ${inr(pf.wages)}${pf.capped ? ' (PF wage ceiling)' : ''}`,
    });
    employerLines.push({
      code: 'PF_ER', name: 'Employer PF', kind: 'employer', amount: pf.employer_pf, position: 10,
      basis: `${inr(pf.employer)} less ${inr(pf.employer_pension)} to pension`,
    });
    employerLines.push({
      code: 'EPS', name: 'Employer pension (EPS)', kind: 'employer', amount: pf.employer_pension, position: 11,
      basis: `8.33% of ${inr(Math.min(pf.wages, Math.round(Number(settings.pf_wage_ceiling) * 100)))}`,
    });
  }

  const esi = employeeStateInsurance(esiWages, settings);
  if (esi) {
    deductionLines.push({
      code: 'ESI', name: 'ESI', kind: 'deduction', amount: esi.employee, position: 20,
      basis: `${Number(settings.esi_employee_rate)}% of ${inr(esi.wages)}, rounded up`,
    });
    employerLines.push({
      code: 'ESI_ER', name: 'Employer ESI', kind: 'employer', amount: esi.employer, position: 20,
      basis: `${Number(settings.esi_employer_rate)}% of ${inr(esi.wages)}, rounded up`,
    });
  }

  const pt = professionalTax(grossEarnings, settings, { month: period.month });
  if (pt) {
    deductionLines.push({
      code: 'PT', name: 'Professional tax', kind: 'deduction', amount: pt.amount, position: 30,
      basis: `${pt.state} slab, ${pt.slab}`,
    });
  }

  // Tax is on the annual figure, so it projects from the UNPRORATED salary —
  // one month of unpaid leave does not change the year's tax band.
  const annualTaxable = annualCtc > 0
    ? annualCtc
    : (taxableEarnings / Math.max(0.01, ratio)) * 12;

  const tds = monthlyTDS(Math.round(annualTaxable / 12), settings, {
    monthsRemaining: monthsLeftInFY(period.month),
    paidSoFarPaise: ytdTaxPaidPaise,
    annualOverridePaise: Math.round(annualTaxable),
  });

  if (tds) {
    deductionLines.push({
      code: 'TDS', name: 'Income tax (TDS)', kind: 'deduction', amount: tds.amount, position: 40,
      basis: `${inr(tds.annual_tax)} annual on ₹${tds.taxable_income.toLocaleString('en-IN')}, over ${tds.months_remaining} months`,
    });
  }

  const totalDeductions = deductionLines.reduce((sum, l) => sum + l.amount, 0);
  const employerContrib = employerLines.reduce((sum, l) => sum + l.amount, 0);
  const netPay = grossEarnings - totalDeductions;

  return {
    employee_id: employee.id,
    employee_name: employee.name,
    employee_code: employee.employee_code ?? null,
    designation: employee.designation ?? null,
    department_name: employee.department_name ?? null,
    joined_on: employee.joined_on ?? null,

    days_in_period: days.days_in_period,
    payable_days: days.payable,
    lop_days: days.lop,
    leave_days: days.leave ?? 0,
    overtime_hours: Number(attendance?.overtime_hours ?? 0),
    attendance_assumed: days.assumed,

    monthly_gross: monthlyGross,
    gross_earnings: grossEarnings,
    total_deductions: totalDeductions,
    net_pay: netPay,
    employer_contrib: employerContrib,
    ctc_for_period: grossEarnings + employerContrib,

    lines: [...earningLines, ...deductionLines, ...employerLines].map(
      ({ pf_applicable, esi_applicable, taxable, ...line }) => line,
    ),

    // Kept out of the stored lines but useful to a preview screen.
    working: { pf_wages: pfWages, esi_wages: esiWages, ratio, basic: proratedBasic },
  };
}
