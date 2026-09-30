import { EVENTS } from '@nexus/contracts/events';
import { postEntry } from './ledger.js';
import { toPaise, toRupees } from './money.js';

const dateOf = (event) => (event.occurred_at ?? new Date().toISOString()).slice(0, 10);
const cashOrBank = (method) => (method === 'cash' ? 'cash' : 'bank');

/**
 * The posting rules: which business event becomes which journal entry.
 *
 * Each entry is keyed by (source, source_ref), so a redelivered event finds
 * its entry already there and posts nothing. Entries are written whether or
 * not the Accounting app is switched on yet — turning it on later shows the
 * books from the start, not from the day it was bought.
 */
export function registerAccountingConsumers({ bus, db, logger }) {
  const rule = (type, build) => bus.subscribe('accounting', type, async (event) => {
    if (!event.org_id) return;
    const entry = await build(event.data ?? {}, event);
    if (!entry) return;
    try {
      await db.transaction((tx) => postEntry(tx, { orgId: event.org_id, userId: event.actor_id ?? null, date: dateOf(event), ...entry }));
    } catch (error) {
      // An unbalanced or impossible posting is a bug in a rule, not something
      // a retry fixes; log it loudly and move on rather than block the queue.
      if (error.status === 400) logger.error({ err: error, type, event: event.id }, 'posting rule produced an invalid entry');
      else throw error;
    }
  });

  // Sales invoice issued: the customer owes us, and so does the tax office.
  // The platform's own subscription invoices share this event name; they are
  // bills *to* the workspace, not its sales, so only this service's invoices post.
  rule(EVENTS.INVOICE_ISSUED, async (d, event) => {
    const own = await db.one(`SELECT 1 FROM invoices WHERE org_id = $1 AND id = $2`, [event.org_id, d.invoice_id]);
    if (!own) return null;
    const total = toPaise(d.total);
    const tax = toPaise(d.tax_total ?? 0);
    if (total <= 0) return null;
    return {
      memo: `Invoice ${d.number} · ${d.customer_name ?? ''}`.trim(), source: 'invoice', sourceRef: d.invoice_id,
      lines: [
        { key: 'ar', debit: toRupees(total), description: d.customer_name },
        { key: 'sales', credit: toRupees(total - tax) },
        { key: 'gst_output', credit: toRupees(tax) },
      ],
    };
  });

  // Money received against invoices.
  rule(EVENTS.PAYMENT_RECEIVED, (d) => ({
    memo: `Payment ${d.number}${d.customer_name ? ` · ${d.customer_name}` : ''}`, source: 'payment', sourceRef: d.payment_id,
    lines: [
      { key: cashOrBank(d.method), debit: d.amount },
      { key: 'ar', credit: d.amount },
    ],
  }));

  // A till sale is paid on the spot.
  rule(EVENTS.POS_SALE_COMPLETED, (d) => {
    const total = toPaise(d.total);
    const tax = toPaise(d.tax_total ?? 0);
    return {
      memo: 'Point of sale', source: 'pos', sourceRef: d.sale_id,
      lines: [
        { key: cashOrBank(d.payment_method), debit: toRupees(total) },
        { key: 'sales', credit: toRupees(total - tax) },
        { key: 'gst_output', credit: toRupees(tax) },
      ],
    };
  });
  rule(EVENTS.POS_SALE_REFUNDED, (d) => {
    const total = toPaise(d.total);
    const tax = toPaise(d.tax_total ?? 0);
    return {
      memo: `Refund of ${d.number}`, source: 'pos_refund', sourceRef: d.sale_id,
      lines: [
        { key: 'sales', debit: toRupees(total - tax) },
        { key: 'gst_output', debit: toRupees(tax) },
        { key: cashOrBank(d.payment_method), credit: toRupees(total) },
      ],
    };
  });

  // An online order is income once it is delivered (and, cash on delivery, paid).
  rule(EVENTS.STORE_ORDER_DELIVERED, (d) => {
    const total = toPaise(d.total);
    const tax = toPaise(d.tax_total ?? 0);
    return {
      memo: `Online order ${d.number}`, source: 'store', sourceRef: d.order_id,
      lines: [
        { key: d.payment_method === 'cod' ? 'cash' : 'bank', debit: toRupees(total) },
        { key: 'sales', credit: toRupees(total - tax) },
        { key: 'gst_output', credit: toRupees(tax) },
      ],
    };
  });

  // Goods received from a vendor: stock and input tax up, vendor owed.
  rule(EVENTS.PURCHASE_RECEIVED, (d, event) => {
    const total = toPaise(d.value);
    const tax = toPaise(d.tax ?? 0);
    if (total <= 0) return null;
    return {
      memo: `Goods received · ${d.number} · ${d.vendor_name ?? ''}`.trim(), source: 'purchase', sourceRef: event.id,
      lines: [
        { key: 'inventory', debit: toRupees(total - tax) },
        { key: 'gst_input', debit: toRupees(tax) },
        { key: 'ap', credit: toRupees(total), description: d.vendor_name },
      ],
    };
  });

  // An employee paid back for what they spent.
  rule(EVENTS.EXPENSE_REIMBURSED, (d) => ({
    memo: `Expense claim ${d.number}${d.title ? ` · ${d.title}` : ''}`, source: 'expense', sourceRef: d.claim_id,
    lines: [
      { key: 'employee_expenses', debit: d.total },
      { key: 'bank', credit: d.total },
    ],
  }));

  // Payroll paid: the full cost is salary expense; net pay leaves the bank;
  // the rest (PF, ESI, TDS) is owed to the government until deposited.
  rule(EVENTS.PAYROLL_PAID, (d) => {
    const cost = toPaise(d.employer_cost ?? d.net_total);
    const net = toPaise(d.net_total);
    if (cost <= 0) return null;
    return {
      memo: `Payroll ${d.period ?? ''}`.trim(), source: 'payroll', sourceRef: d.run_id,
      lines: [
        { key: 'salaries', debit: toRupees(cost) },
        { key: 'bank', credit: toRupees(net) },
        { key: 'statutory_payable', credit: toRupees(cost - net) },
      ],
    };
  });

  logger.info('posting sales, purchases, payroll and expenses to the ledger');
}
