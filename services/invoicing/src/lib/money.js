/**
 * Money arithmetic in integer paise.
 *
 * Every calculation converts to paise, works in integers, and converts back
 * only at the edges. 0.1 + 0.2 must never appear in a tax total, and a
 * customer must never see a figure that does not add up when they check it
 * by hand.
 */

/** "1234.56" | 1234.56 → 123456 */
export function toPaise(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = typeof value === 'number' ? value : Number(String(value).replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(number)) return 0;
  // Round half away from zero — the convention every accountant expects.
  return Math.round(Math.abs(number) * 100) * Math.sign(number || 1);
}

/** 123456 → "1234.56" */
export const toRupees = (paise) => (paise / 100).toFixed(2);

/** Percentage of an amount, in paise, rounded half away from zero. */
export const percentOf = (paise, percent) => Math.round((paise * Number(percent)) / 100);

/**
 * GST split.
 *
 * Within one state the tax is halved into CGST and SGST; across states it is
 * a single IGST at the full rate. The split is computed from the total tax so
 * the two halves always reconstitute it exactly — halving the *rate* first
 * can lose a paisa on odd amounts.
 */
export function splitTax(taxablePaise, ratePercent, isInterstate) {
  const total = percentOf(taxablePaise, ratePercent);

  if (isInterstate) {
    return { cgst: 0, sgst: 0, igst: total, total };
  }

  const half = Math.floor(total / 2);
  // The odd paisa goes to CGST by convention, so cgst + sgst === total.
  return { cgst: total - half, sgst: half, igst: 0, total };
}

/**
 * Compute one line: discount, taxable value, tax split, line total.
 * Quantity carries three decimals (0.5 hours, 2.750 kg) so it is scaled
 * separately from money.
 */
export function computeLine(line, isInterstate) {
  const quantity = Math.round(Number(line.quantity ?? 1) * 1000); // milli-units
  const unitPrice = toPaise(line.unit_price);

  const subtotal = Math.round((quantity * unitPrice) / 1000);
  const discount = percentOf(subtotal, line.discount_percent ?? 0);
  const taxable = subtotal - discount;
  const tax = splitTax(taxable, line.tax_rate ?? 0, isInterstate);

  return {
    line_subtotal: subtotal,
    line_discount: discount,
    line_taxable: taxable,
    cgst_amount: tax.cgst,
    sgst_amount: tax.sgst,
    igst_amount: tax.igst,
    line_total: taxable + tax.total,
  };
}

/**
 * Compute a whole invoice from its lines.
 *
 * Tax is summed per line rather than applied to the invoice total, because
 * lines can carry different rates — the only way to get a mixed-rate invoice
 * right, and what the GST return expects.
 *
 * The grand total is rounded to the nearest rupee and the difference recorded
 * as an explicit round-off line, which is how Indian invoices are presented.
 */
export function computeInvoice(lines, { isInterstate, roundToRupee = true }) {
  const computed = lines.map((line, index) => ({
    ...line,
    position: line.position ?? index,
    ...computeLine(line, isInterstate),
  }));

  const sum = (key) => computed.reduce((total, line) => total + line[key], 0);

  const subtotal = sum('line_subtotal');
  const discountTotal = sum('line_discount');
  const taxableTotal = sum('line_taxable');
  const cgstTotal = sum('cgst_amount');
  const sgstTotal = sum('sgst_amount');
  const igstTotal = sum('igst_amount');
  const taxTotal = cgstTotal + sgstTotal + igstTotal;

  const beforeRounding = taxableTotal + taxTotal;
  const rounded = roundToRupee ? Math.round(beforeRounding / 100) * 100 : beforeRounding;
  const roundOff = rounded - beforeRounding;

  return {
    lines: computed,
    totals: {
      subtotal,
      discount_total: discountTotal,
      taxable_total: taxableTotal,
      cgst_total: cgstTotal,
      sgst_total: sgstTotal,
      igst_total: igstTotal,
      tax_total: taxTotal,
      round_off: roundOff,
      total: rounded,
    },
  };
}

/** Serialise a paise-denominated object to the numeric(14,2) strings the DB takes. */
export function asRupees(paiseObject) {
  return Object.fromEntries(
    Object.entries(paiseObject).map(([key, value]) => [key, toRupees(value)]),
  );
}
