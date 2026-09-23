import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest, conflict,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { computeInvoice, toPaise, toRupees, asRupees } from '../lib/money.js';
import { nextNumber, fiscalYear, isInterstate, ageingBucket, stateCodeFromGstin } from '../lib/numbering.js';
import { ensureTemplate } from '../lib/templates.js';

const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description'],
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 300 },
    hsn_sac: { type: 'string', maxLength: 20 },
    quantity: { type: 'number', minimum: 0, maximum: 1000000 },
    unit: { type: 'string', maxLength: 20 },
    unit_price: { type: ['string', 'number'] },
    discount_percent: { type: 'number', minimum: 0, maximum: 100 },
    tax_rate: { type: 'number', minimum: 0, maximum: 100 },
  },
};

export async function invoiceRoutes(app) {
  const { db, settings } = app;

  /** Recompute totals and rewrite lines. Only ever called on a draft. */
  async function rewrite(tx, { orgId, invoice, lines }) {
    const interstate = invoice.is_interstate;
    const { lines: computed, totals } = computeInvoice(lines, { isInterstate: interstate });

    await tx.query(`DELETE FROM invoice_lines WHERE org_id = $1 AND invoice_id = $2`,
      [orgId, invoice.id]);

    for (const line of computed) {
      await tx.query(
        `INSERT INTO invoice_lines
           (id, org_id, invoice_id, position, description, hsn_sac, quantity, unit,
            unit_price, discount_percent, tax_rate, line_subtotal, line_discount,
            line_taxable, cgst_amount, sgst_amount, igst_amount, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          id('inl'), orgId, invoice.id, line.position, line.description,
          line.hsn_sac ?? null, line.quantity ?? 1, line.unit ?? 'nos',
          toRupees(toPaise(line.unit_price)), line.discount_percent ?? 0, line.tax_rate ?? 0,
          toRupees(line.line_subtotal), toRupees(line.line_discount), toRupees(line.line_taxable),
          toRupees(line.cgst_amount), toRupees(line.sgst_amount), toRupees(line.igst_amount),
          toRupees(line.line_total),
        ],
      );
    }

    const money = asRupees(totals);

    return tx.one(
      `UPDATE invoices SET
         subtotal = $3, discount_total = $4, taxable_total = $5,
         cgst_total = $6, sgst_total = $7, igst_total = $8,
         tax_total = $9, round_off = $10, total = $11,
         amount_due = ($11::numeric - amount_paid)
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [
        invoice.id, orgId, money.subtotal, money.discount_total, money.taxable_total,
        money.cgst_total, money.sgst_total, money.igst_total,
        money.tax_total, money.round_off, money.total,
      ],
    );
  }

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/invoicing/invoices',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.view')],
      schema: {
        querystring: query({
          status: v.enum(['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void']),
          customer_id: v.id('cmp'),
          overdue: { type: 'boolean' },
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['created_at', 'issue_date', 'due_date', 'total'] });
      const qs = request.query;

      const where = ['i.org_id = $1'];
      const values = [orgId];

      if (qs.status) { values.push(qs.status); where.push(`i.status = $${values.length}`); }
      if (qs.customer_id) { values.push(qs.customer_id); where.push(`i.customer_id = $${values.length}`); }
      if (qs.overdue) where.push(`i.status IN ('issued','partially_paid','overdue') AND i.due_date < current_date`);
      if (qs.q) {
        values.push(`%${qs.q}%`);
        where.push(`(i.number ILIKE $${values.length} OR i.customer_name ILIKE $${values.length}
                     OR i.reference ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');

      const [rows, total, summary] = await Promise.all([
        db.rows(
          `SELECT i.* FROM invoices i WHERE ${clause}
            ORDER BY i.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM invoices i WHERE ${clause}`, values),
        db.one(
          `SELECT
             COALESCE(sum(amount_due) FILTER (WHERE status IN ('issued','partially_paid','overdue')), 0)::text AS outstanding,
             COALESCE(sum(amount_due) FILTER (WHERE status IN ('issued','partially_paid','overdue')
               AND due_date < current_date), 0)::text AS overdue,
             COALESCE(sum(amount_paid) FILTER (WHERE updated_at >= date_trunc('month', now())), 0)::text AS collected_this_month,
             count(*) FILTER (WHERE status = 'draft')::int AS drafts
           FROM invoices WHERE org_id = $1 AND status <> 'void'`,
          [orgId],
        ),
      ]);

      return { data: rows.map(shape), meta: { ...page.meta(total.n), summary } };
    },
  );

  // ═══════════════════════════════════════════════════════════════════ READ
  app.get(
    '/invoicing/invoices/:invoiceId',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.view')],
      schema: { params: params({ invoiceId: v.id('inv') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const invoice = await db.one(
        `SELECT * FROM invoices WHERE id = $1 AND org_id = $2`,
        [request.params.invoiceId, orgId],
      );
      if (!invoice) throw notFound('Invoice');

      const [lines, allocations] = await Promise.all([
        db.rows(
          `SELECT * FROM invoice_lines WHERE org_id = $1 AND invoice_id = $2 ORDER BY position`,
          [orgId, invoice.id],
        ),
        db.rows(
          `SELECT a.*, p.number AS payment_number, p.method, p.received_on, p.reference
             FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
            WHERE a.org_id = $1 AND a.invoice_id = $2 ORDER BY p.received_on DESC`,
          [orgId, invoice.id],
        ),
      ]);

      return { data: { ...shape(invoice), lines, payments: allocations } };
    },
  );

  // ═════════════════════════════════════════════════════════════════ CREATE
  app.post(
    '/invoicing/invoices',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.create')],
      schema: {
        body: body(
          {
            customer_id: v.id('cmp'),
            customer_name: v.text(200),
            customer_gstin: v.text(20),
            place_of_supply: { type: 'string', maxLength: 2 },
            issue_date: v.date,
            terms_days: v.int(0, 365),
            reference: v.text(80),
            notes: v.longText,
            terms: v.longText,
            lines: { type: 'array', items: LINE_SCHEMA, minItems: 1, maxItems: 200 },
          },
          ['lines'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      let customer = null;
      if (b.customer_id) {
        customer = await db.one(`SELECT * FROM customers WHERE id = $1 AND org_id = $2`,
          [b.customer_id, orgId]);
        if (!customer) throw notFound('Customer');
      }

      const name = b.customer_name ?? customer?.name;
      if (!name) throw badRequest('An invoice needs a customer.');

      const org = await settings.forOrg(orgId);
      const buyerState = b.place_of_supply
        ?? customer?.place_of_supply
        ?? stateCodeFromGstin(b.customer_gstin ?? customer?.gstin);

      const interstate = isInterstate(org.state_code, buyerState);

      const invoice = await db.transaction(async (tx) => {
        const created = await tx.one(
          `INSERT INTO invoices
             (id, org_id, customer_id, customer_name, customer_gstin, billing_address,
              place_of_supply, is_interstate, issue_date, terms_days, due_date,
              currency, reference, notes, terms, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                   COALESCE($9::date, current_date), COALESCE($10, 30),
                   COALESCE($9::date, current_date) + COALESCE($10, 30),
                   $11,$12,$13,$14,$15)
           RETURNING *`,
          [
            id('inv'), orgId, b.customer_id ?? null, name,
            b.customer_gstin ?? customer?.gstin ?? null,
            JSON.stringify(customer?.billing_address ?? {}),
            buyerState ?? null, interstate, b.issue_date ?? null, b.terms_days ?? null,
            org.currency, b.reference ?? null, b.notes ?? null, b.terms ?? org.default_terms,
            userId,
          ],
        );

        return rewrite(tx, { orgId, invoice: created, lines: b.lines });
      });

      return reply.status(201).send({ data: shape(invoice) });
    },
  );

  // ═════════════════════════════════════════════════════════════════ UPDATE
  /** Only drafts are editable. An issued invoice is a legal document. */
  app.patch(
    '/invoicing/invoices/:invoiceId',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.edit')],
      schema: {
        params: params({ invoiceId: v.id('inv') }),
        body: body({
          customer_id: v.id('cmp'),
          customer_name: v.text(200),
          customer_gstin: v.text(20),
          place_of_supply: { type: 'string', maxLength: 2 },
          issue_date: v.date,
          terms_days: v.int(0, 365),
          reference: v.text(80),
          notes: v.longText,
          terms: v.longText,
          lines: { type: 'array', items: LINE_SCHEMA, minItems: 1, maxItems: 200 },
        }),
      },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const invoice = await db.one(`SELECT * FROM invoices WHERE id = $1 AND org_id = $2`,
        [request.params.invoiceId, orgId]);
      if (!invoice) throw notFound('Invoice');
      if (invoice.status !== 'draft') {
        throw badRequest(
          `Invoice ${invoice.number} has been issued and cannot be edited. Void it and raise a new one.`,
          { status: invoice.status },
        );
      }

      const b = request.body;
      const org = await settings.forOrg(orgId);

      const updated = await db.transaction(async (tx) => {
        const buyerState = b.place_of_supply ?? invoice.place_of_supply;
        const interstate = isInterstate(org.state_code, buyerState);

        const row = await tx.one(
          `UPDATE invoices SET
             customer_id     = COALESCE($3, customer_id),
             customer_name   = COALESCE($4, customer_name),
             customer_gstin  = COALESCE($5, customer_gstin),
             place_of_supply = COALESCE($6, place_of_supply),
             is_interstate   = $7,
             issue_date      = COALESCE($8::date, issue_date),
             terms_days      = COALESCE($9, terms_days),
             due_date        = COALESCE($8::date, issue_date) + COALESCE($9, terms_days),
             reference       = COALESCE($10, reference),
             notes           = COALESCE($11, notes),
             terms           = COALESCE($12, terms)
           WHERE id = $1 AND org_id = $2 RETURNING *`,
          [
            invoice.id, orgId, b.customer_id ?? null, b.customer_name ?? null,
            b.customer_gstin ?? null, buyerState ?? null, interstate,
            b.issue_date ?? null, b.terms_days ?? null, b.reference ?? null,
            b.notes ?? null, b.terms ?? null,
          ],
        );

        if (b.lines) return rewrite(tx, { orgId, invoice: row, lines: b.lines });

        // Lines unchanged, but the tax split may have flipped with the state.
        if (interstate !== invoice.is_interstate) {
          const existing = await tx.rows(
            `SELECT * FROM invoice_lines WHERE org_id = $1 AND invoice_id = $2 ORDER BY position`,
            [orgId, row.id],
          );
          return rewrite(tx, { orgId, invoice: row, lines: existing });
        }

        return row;
      });

      return { data: shape(updated) };
    },
  );

  // ══════════════════════════════════════════════════════════════════ ISSUE
  /** Spends a number from the sequence and makes the invoice immutable. */
  app.post(
    '/invoicing/invoices/:invoiceId/issue',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.send')],
      schema: { params: params({ invoiceId: v.id('inv') }) },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      const invoice = await db.one(`SELECT * FROM invoices WHERE id = $1 AND org_id = $2`,
        [request.params.invoiceId, orgId]);
      if (!invoice) throw notFound('Invoice');
      if (invoice.status !== 'draft') {
        throw conflict(`This invoice was already issued as ${invoice.number}.`,
          { number: invoice.number });
      }

      const lineCount = await db.one(
        `SELECT count(*)::int AS n FROM invoice_lines WHERE org_id = $1 AND invoice_id = $2`,
        [orgId, invoice.id],
      );
      if (lineCount.n === 0) throw badRequest('An invoice needs at least one line.');
      if (Number(invoice.total) <= 0) throw badRequest('An invoice must be for more than zero.');

      const org = await settings.forOrg(orgId);

      // Stamp the design this invoice goes out under. Rebranding later must
      // not change how an invoice the customer already holds renders back.
      const template = await ensureTemplate(db, orgId);

      const issued = await db.transaction(async (tx) => {
        const assigned = await nextNumber(tx, {
          orgId, kind: 'invoice',
          date: invoice.issue_date ?? new Date(),
          fiscalYearStart: org.fiscal_year_start,
        });

        const row = await tx.one(
          `UPDATE invoices
              SET number = $3, fiscal_year = $4, status = 'issued',
                  issue_date = COALESCE(issue_date, current_date),
                  due_date = COALESCE(issue_date, current_date) + terms_days,
                  amount_due = total, issued_by = $5,
                  template_id = COALESCE(template_id, $6)
            WHERE id = $1 AND org_id = $2 RETURNING *`,
          [invoice.id, orgId, assigned.number, assigned.fiscal_year, userId, template?.id ?? null],
        );

        tx.emit({
          type: EVENTS.INVOICE_ISSUED,
          org_id: orgId,
          actor_id: userId,
          data: {
            invoice_id: row.id, number: row.number, customer_id: row.customer_id,
            customer_name: row.customer_name, total: row.total, currency: row.currency,
            due_date: row.due_date, tax_total: row.tax_total,
          },
        });

        return row;
      });

      return { data: shape(issued) };
    },
  );

  // ═══════════════════════════════════════════════════════════════════ VOID
  app.post(
    '/invoicing/invoices/:invoiceId/void',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.delete')],
      schema: {
        params: params({ invoiceId: v.id('inv') }),
        body: body({ reason: v.text(240) }, ['reason']),
      },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;

      const invoice = await db.one(`SELECT * FROM invoices WHERE id = $1 AND org_id = $2`,
        [request.params.invoiceId, orgId]);
      if (!invoice) throw notFound('Invoice');
      if (invoice.status === 'void') throw badRequest('This invoice is already void.');
      if (Number(invoice.amount_paid) > 0) {
        throw badRequest(
          'Money has been received against this invoice. Raise a credit note instead of voiding it.',
          { amount_paid: invoice.amount_paid },
        );
      }

      // The number is NOT returned to the pool — a void invoice keeps its
      // number so the sequence stays gap-free, which is the entire point.
      const voided = await db.one(
        `UPDATE invoices SET status = 'void', voided_at = now(), void_reason = $3, amount_due = 0
          WHERE id = $1 AND org_id = $2 RETURNING *`,
        [invoice.id, orgId, request.body.reason],
      );

      return { data: shape(voided) };
    },
  );

  // ════════════════════════════════════════════════════════════ AGEING REPORT
  app.get(
    '/invoicing/ageing',
    { preHandler: [app.loadContext, requirePermission('invoicing.reports.view')] },
    async (request) => {
      const { orgId } = request.ctx;

      const rows = await db.rows(
        `SELECT i.id, i.number, i.customer_id, i.customer_name, i.due_date,
                i.total, i.amount_due, i.status
           FROM invoices i
          WHERE i.org_id = $1 AND i.status IN ('issued','partially_paid','overdue')
            AND i.amount_due > 0
          ORDER BY i.due_date`,
        [orgId],
      );

      const buckets = { not_due: 0, '1_30': 0, '31_60': 0, '61_90': 0, over_90: 0 };
      const byCustomer = new Map();

      for (const row of rows) {
        const bucket = ageingBucket(row.due_date);
        const due = toPaise(row.amount_due);
        buckets[bucket] += due;

        const key = row.customer_id ?? row.customer_name;
        const entry = byCustomer.get(key) ?? {
          customer_id: row.customer_id, customer_name: row.customer_name,
          total: 0, not_due: 0, '1_30': 0, '31_60': 0, '61_90': 0, over_90: 0, invoices: 0,
        };
        entry[bucket] += due;
        entry.total += due;
        entry.invoices += 1;
        byCustomer.set(key, entry);
      }

      const rupees = (paise) => toRupees(paise);

      return {
        data: {
          buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, rupees(v)])),
          total: rupees(Object.values(buckets).reduce((a, b) => a + b, 0)),
          by_customer: [...byCustomer.values()]
            .sort((a, b) => b.total - a.total)
            .map((entry) => ({
              ...entry,
              total: rupees(entry.total),
              not_due: rupees(entry.not_due),
              '1_30': rupees(entry['1_30']),
              '31_60': rupees(entry['31_60']),
              '61_90': rupees(entry['61_90']),
              over_90: rupees(entry.over_90),
            })),
          as_of: new Date().toISOString().slice(0, 10),
        },
      };
    },
  );
}

function shape(invoice) {
  return {
    ...invoice,
    is_overdue:
      ['issued', 'partially_paid', 'overdue'].includes(invoice.status) &&
      invoice.due_date != null &&
      new Date(`${invoice.due_date}T00:00:00`) < new Date(),
    tax_breakdown: invoice.is_interstate
      ? { igst: invoice.igst_total }
      : { cgst: invoice.cgst_total, sgst: invoice.sgst_total },
  };
}
