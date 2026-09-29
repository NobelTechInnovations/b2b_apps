/**
 * Money is computed in integer paise and written back as rupee strings, so
 * 0.1 + 0.2 never appears on a receipt.
 */
export const toPaise = (value) => Math.round(Number(value ?? 0) * 100);
export const toRupees = (paise) => (Math.round(paise) / 100).toFixed(2);

/** One line: quantity × price, less a discount, plus tax. All in paise. */
export function lineTotals({ quantity, unit_price: unitPrice, discount_percent: discount = 0, tax_rate: taxRate = 0 }) {
  const gross = Math.round(toPaise(unitPrice) * Number(quantity));
  const discountPaise = Math.round((gross * Number(discount)) / 100);
  const taxable = gross - discountPaise;
  const tax = Math.round((taxable * Number(taxRate)) / 100);
  return { gross, discount: discountPaise, taxable, tax, total: taxable + tax };
}

export function sumLines(lines) {
  return lines.reduce((acc, line) => {
    const t = lineTotals(line);
    acc.subtotal += t.gross;
    acc.discount += t.discount;
    acc.tax += t.tax;
    acc.total += t.total;
    return acc;
  }, { subtotal: 0, discount: 0, tax: 0, total: 0 });
}
