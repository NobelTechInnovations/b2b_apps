/**
 * Indian statutory deductions.
 *
 * Every rate and threshold in here is law, not preference, and every one of
 * them moves with a Budget. They are therefore data — kept in one place, with
 * the year they belong to written down — rather than scattered as literals
 * through the calculation. When a Budget changes a slab, one table changes.
 *
 * All amounts are integer paise. All rates are percentages as plain numbers.
 */
import { percentOf } from './money.js';

/** The financial year these figures are stated for. */
export const STATUTORY_YEAR = '2026-27';

// ════════════════════════════════════════════════════════════ PROVIDENT FUND
/**
 * PF is 12% of "PF wages" — basic + dearness allowance — subject to a
 * statutory ceiling of ₹15,000 a month. An employer may contribute on the
 * actual wage instead, which is more generous and perfectly legal, so it is
 * a setting rather than a constant.
 *
 * The employer's 12% is split: 8.33% of wages (capped at the ceiling) funds
 * the pension scheme, the remainder the provident fund itself. Employees see
 * only their own 12%, but the split matters for the ECR return.
 */
export const EPS_RATE = 8.33;

export function providentFund(pfWagesPaise, settings) {
  if (!settings.pf_enabled) return null;

  const ceiling = Math.round(Number(settings.pf_wage_ceiling) * 100);
  const wages = settings.pf_on_actual_wage ? pfWagesPaise : Math.min(pfWagesPaise, ceiling);
  if (wages <= 0) return null;

  const employee = percentOf(wages, Number(settings.pf_employee_rate));
  const employer = percentOf(wages, Number(settings.pf_employer_rate));

  // EPS is always computed on the capped wage, even when PF itself is not.
  const pensionWages = Math.min(wages, ceiling);
  const pension = percentOf(pensionWages, EPS_RATE);

  return {
    wages,
    employee,
    employer,
    // The employer's share minus what went to pension. Never negative: a
    // sub-8.33% employer rate would otherwise produce a negative EPF line.
    employer_pf: Math.max(0, employer - pension),
    employer_pension: Math.min(pension, employer),
    capped: wages < pfWagesPaise,
  };
}

// ═══════════════════════════════════════════════════════════════════════ ESI
/**
 * ESI applies only while gross pay is at or below ₹21,000 a month. Crossing
 * the ceiling mid-contribution-period does not end liability immediately —
 * the law requires contributions until the period ends (Apr–Sep, Oct–Mar).
 * That continuation is honoured when the caller says the person was already
 * covered, which is why `alreadyCovered` exists rather than a bare comparison.
 */
export function employeeStateInsurance(grossPaise, settings, { alreadyCovered = false } = {}) {
  if (!settings.esi_enabled) return null;

  const ceiling = Math.round(Number(settings.esi_gross_ceiling) * 100);
  if (grossPaise > ceiling && !alreadyCovered) return null;
  if (grossPaise <= 0) return null;

  // ESI contributions are rounded UP to the next rupee, per the regulations.
  const roundUp = (paise) => Math.ceil(paise / 100) * 100;

  return {
    wages: grossPaise,
    employee: roundUp(percentOf(grossPaise, Number(settings.esi_employee_rate))),
    employer: roundUp(percentOf(grossPaise, Number(settings.esi_employer_rate))),
    continued: grossPaise > ceiling,
  };
}

// ═════════════════════════════════════════════════════════ PROFESSIONAL TAX
/**
 * Professional tax is levied by the state, on a monthly slab of gross pay.
 * Amounts are in rupees; `february` marks the states that collect a larger
 * final instalment to reach the ₹2,500 annual statutory maximum.
 */
export const PT_SLABS = {
  MH: {
    name: 'Maharashtra',
    slabs: [
      { upTo: 7500, amount: 0 },
      { upTo: 10000, amount: 175 },
      { upTo: Infinity, amount: 200, february: 300 },
    ],
  },
  KA: {
    name: 'Karnataka',
    slabs: [
      { upTo: 24999, amount: 0 },
      { upTo: Infinity, amount: 200 },
    ],
  },
  WB: {
    name: 'West Bengal',
    slabs: [
      { upTo: 10000, amount: 0 },
      { upTo: 15000, amount: 110 },
      { upTo: 25000, amount: 130 },
      { upTo: 40000, amount: 150 },
      { upTo: Infinity, amount: 200 },
    ],
  },
  TN: {
    name: 'Tamil Nadu',
    slabs: [
      { upTo: 21000, amount: 0 },
      { upTo: 30000, amount: 135 },
      { upTo: 45000, amount: 315 },
      { upTo: 60000, amount: 690 },
      { upTo: 75000, amount: 1025 },
      { upTo: Infinity, amount: 1250 },
    ],
  },
  TS: {
    name: 'Telangana',
    slabs: [
      { upTo: 15000, amount: 0 },
      { upTo: 20000, amount: 150 },
      { upTo: Infinity, amount: 200 },
    ],
  },
  GJ: {
    name: 'Gujarat',
    slabs: [
      { upTo: 12000, amount: 0 },
      { upTo: Infinity, amount: 200 },
    ],
  },
  // States with no professional tax at all — Delhi, UP, Haryana and others.
  NONE: { name: 'Not levied', slabs: [{ upTo: Infinity, amount: 0 }] },
};

export function professionalTax(grossPaise, settings, { month } = {}) {
  if (!settings.pt_enabled) return null;

  const state = PT_SLABS[settings.pt_state] ?? PT_SLABS.NONE;
  const gross = grossPaise / 100;
  const slab = state.slabs.find((s) => gross <= s.upTo) ?? state.slabs[state.slabs.length - 1];

  const rupees = month === 2 && slab.february ? slab.february : slab.amount;
  if (!rupees) return null;

  return { amount: rupees * 100, state: state.name, slab: `up to ₹${slab.upTo === Infinity ? '∞' : slab.upTo}` };
}

// ═══════════════════════════════════════════════════════════════════════ TDS
/**
 * Income-tax slabs, new regime.
 *
 * This produces a monthly instalment by projecting the current month's taxable
 * pay over the remainder of the year — the same "average rate" method the Act
 * requires of an employer. It deliberately does NOT model Chapter VI-A
 * deductions, house-property loss or declared investments: those are the
 * employee's declaration, and guessing at them would under-deduct. The old
 * regime is offered as a slab table only, for the same reason.
 */
export const TAX_SLABS = {
  new: {
    standardDeduction: 75_000,
    // Section 87A: no tax where total income is at or below this.
    rebateLimit: 1_200_000,
    rebateCap: 60_000,
    slabs: [
      { upTo: 400_000, rate: 0 },
      { upTo: 800_000, rate: 5 },
      { upTo: 1_200_000, rate: 10 },
      { upTo: 1_600_000, rate: 15 },
      { upTo: 2_000_000, rate: 20 },
      { upTo: 2_400_000, rate: 25 },
      { upTo: Infinity, rate: 30 },
    ],
  },
  old: {
    standardDeduction: 50_000,
    rebateLimit: 500_000,
    rebateCap: 12_500,
    slabs: [
      { upTo: 250_000, rate: 0 },
      { upTo: 500_000, rate: 5 },
      { upTo: 1_000_000, rate: 20 },
      { upTo: Infinity, rate: 30 },
    ],
  },
};

/** Health and education cess, on the tax rather than on the income. */
export const CESS_RATE = 4;

/** Surcharge on very high incomes, new regime capped at 25%. */
const SURCHARGE = [
  { above: 20_000_000, rate: 25 },
  { above: 10_000_000, rate: 15 },
  { above: 5_000_000, rate: 10 },
];

/** Annual tax on an annual taxable income, in rupees. Returns paise. */
export function annualTax(annualIncomeRupees, regime = 'new') {
  const table = TAX_SLABS[regime] ?? TAX_SLABS.new;
  const taxable = Math.max(0, annualIncomeRupees - table.standardDeduction);

  let tax = 0;
  let floor = 0;
  for (const slab of table.slabs) {
    if (taxable <= floor) break;
    const band = Math.min(taxable, slab.upTo) - floor;
    tax += (band * slab.rate) / 100;
    floor = slab.upTo;
  }

  // The 87A rebate wipes out tax entirely below the limit; just above it, the
  // marginal relief keeps the tax from exceeding the income over the limit.
  if (taxable <= table.rebateLimit) {
    tax = Math.max(0, tax - table.rebateCap);
  } else {
    const excess = taxable - table.rebateLimit;
    if (tax > excess) tax = Math.min(tax, excess);
  }

  const band = SURCHARGE.find((s) => taxable > s.above);
  if (band) tax += (tax * band.rate) / 100;

  tax += (tax * CESS_RATE) / 100;

  return {
    taxable_income: taxable,
    annual_tax: Math.round(tax * 100),
    regime,
    standard_deduction: table.standardDeduction,
    surcharge_rate: band?.rate ?? 0,
  };
}

/**
 * This month's TDS.
 *
 * `monthsRemaining` spreads the year's liability over what is left of it, so
 * a mid-year joiner or a mid-year raise settles by March instead of leaving a
 * shortfall. `paidSoFar` is what has already been deducted this year.
 */
export function monthlyTDS(monthlyTaxablePaise, settings, { monthsRemaining = 12, paidSoFarPaise = 0, annualOverridePaise = null } = {}) {
  if (!settings.tds_enabled) return null;

  const projectedAnnual = annualOverridePaise ?? monthlyTaxablePaise * 12;
  const result = annualTax(projectedAnnual / 100, settings.tds_regime);
  if (result.annual_tax <= 0) return null;

  const outstanding = Math.max(0, result.annual_tax - paidSoFarPaise);
  const amount = Math.round(outstanding / Math.max(1, monthsRemaining));
  if (amount <= 0) return null;

  return {
    amount,
    ...result,
    projected_annual_income: Math.round(projectedAnnual / 100),
    months_remaining: monthsRemaining,
  };
}

/**
 * Months left in the Indian financial year, which runs April to March.
 * March is month 1 of 1 remaining; April is 12.
 */
export function monthsLeftInFY(month) {
  return month >= 4 ? 12 - month + 4 : 4 - month;
}
