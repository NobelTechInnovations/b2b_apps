import { id } from '@nexus/db-kit';
import { badRequest } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { computeInvoice, toPaise, toRupees, asRupees } from './money.js';
import { nextNumber, isInterstate, stateCodeFromGstin } from './numbering.js';
import { ensureTemplate } from './templates.js';

/**
 * Invoices raised by the system rather than typed in: a subscription's
 * renewal, an accepted quote, a completed field visit. Same GST arithmetic,
 * same gap-free numbering and the same `invoice.issued` event as an invoice
 * raised by hand — so Accounting and the customer cannot tell the difference.
 *
 * Idempotent on (source, source_ref): asking twice returns the first invoice.
 */
export async function createInvoice(tx, {
  settings, orgId, userId = null, customer, lines, source, sourceRef = null, reference = null, notes = null,
  termsDays = null, issue = false,
}) {
  if (!customer?.name) throw badRequest('An invoice needs a customer.');
  if (!lines?.length) throw badRequest('An invoice needs at least one line.');
  if (sourceRef) {
    const existing = await tx.one(`SELECT * FROM invoices WHERE org_id = $1 AND source = $2 AND source_ref = $3`, [orgId, source, sourceRef]);
    if (existing) return existing;
  }

  const org = await settings.forOrg(orgId);
  const known = customer.id ? await tx.one(`SELECT * FROM customers WHERE org_id = $1 AND id = $2`, [orgId, customer.id]) : null;
  const gstin = customer.gstin ?? known?.gstin ?? null;
  const buyerState = customer.place_of_supply ?? known?.place_of_supply ?? stateCodeFromGstin(gstin);
  const interstate = isInterstate(org.state_code, buyerState);

  const normalised = lines.map((line, position) => ({
    position, description: line.description, hsn_sac: line.hsn_sac ?? null, quantity: Number(line.quantity ?? 1), unit: line.unit ?? 'nos',
    unit_price: toRupees(toPaise(line.unit_price ?? 0)), discount_percent: Number(line.discount_percent ?? 0),
    tax_rate: line.tax_rate === undefined || line.tax_rate === null ? org.default_tax_rate : Number(line.tax_rate),
  }));
  const { lines: computed, totals } = computeInvoice(normalised, { isInterstate: interstate });
  const money = asRupees(totals);
  if (toPaise(money.total) <= 0) throw badRequest('An invoice must be for more than zero.');
  const terms = termsDays ?? org.default_terms_days ?? 30;

  const invoice = await tx.one(
    `INSERT INTO invoices
       (id, org_id, customer_id, customer_name, customer_gstin, billing_address, place_of_supply, is_interstate,
        issue_date, terms_days, due_date, currency, subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total,
        tax_total, round_off, total, amount_due, reference, source, source_ref, notes, terms, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, current_date, $9::integer, current_date + $9::integer, $10,
             $11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (org_id, source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      id('inv'), orgId, known?.id ?? null, customer.name, gstin, JSON.stringify(known?.billing_address ?? {}), buyerState ?? null, interstate,
      terms, org.currency, money.subtotal, money.discount_total, money.taxable_total, money.cgst_total, money.sgst_total, money.igst_total,
      money.tax_total, money.round_off, money.total, reference, source, sourceRef, notes, org.default_terms, userId,
    ],
  );
  if (!invoice) return tx.one(`SELECT * FROM invoices WHERE org_id = $1 AND source = $2 AND source_ref = $3`, [orgId, source, sourceRef]);

  for (const line of computed) {
    await tx.query(
      `INSERT INTO invoice_lines (id, org_id, invoice_id, position, description, hsn_sac, quantity, unit, unit_price, discount_percent, tax_rate,
                                  line_subtotal, line_discount, line_taxable, cgst_amount, sgst_amount, igst_amount, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id('inl'), orgId, invoice.id, line.position, line.description, line.hsn_sac, line.quantity, line.unit, line.unit_price,
        line.discount_percent, line.tax_rate, toRupees(line.line_subtotal), toRupees(line.line_discount), toRupees(line.line_taxable),
        toRupees(line.cgst_amount), toRupees(line.sgst_amount), toRupees(line.igst_amount), toRupees(line.line_total)],
    );
  }
  return issue ? issueInvoice(tx, { settings, orgId, userId, invoice }) : invoice;
}

/** Spend the next number and make the invoice a legal document. */
export async function issueInvoice(tx, { settings, orgId, userId = null, invoice }) {
  if (invoice.status !== 'draft') return invoice;
  const org = await settings.forOrg(orgId);
  const template = await ensureTemplate(tx, orgId);
  const assigned = await nextNumber(tx, { orgId, kind: 'invoice', date: invoice.issue_date ?? new Date(), fiscalYearStart: org.fiscal_year_start });
  const row = await tx.one(
    `UPDATE invoices SET number = $3, fiscal_year = $4, status = 'issued', issue_date = COALESCE(issue_date, current_date),
            due_date = COALESCE(issue_date, current_date) + terms_days, amount_due = total, issued_by = $5,
            template_id = COALESCE(template_id, $6)
      WHERE id = $1 AND org_id = $2 RETURNING *`,
    [invoice.id, orgId, assigned.number, assigned.fiscal_year, userId, template?.id ?? null],
  );
  tx.emit({
    type: EVENTS.INVOICE_ISSUED, org_id: orgId, actor_id: userId,
    data: {
      invoice_id: row.id, number: row.number, customer_id: row.customer_id, customer_name: row.customer_name,
      total: row.total, currency: row.currency, due_date: row.due_date, tax_total: row.tax_total, source: row.source, source_ref: row.source_ref,
    },
  });
  return row;
}
