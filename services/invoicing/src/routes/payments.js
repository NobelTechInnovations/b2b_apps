import { id, paginate } from '@nexus/db-kit';
import {
  requirePermission, body, query, params, validate as v, notFound, badRequest,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { toPaise, toRupees } from '../lib/money.js';
import { nextNumber } from '../lib/numbering.js';

export async function paymentRoutes(app) {
  const { db, settings } = app;

  /**
   * An invoice's status follows entirely from what has been allocated to it.
   * Derived here, never set by hand, so a payment and a status can never
   * disagree.
   */
  async function settle(tx, { orgId, invoiceId }) {
    const invoice = await tx.one(
      `SELECT * FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [invoiceId, orgId],
    );
    if (!invoice) return null;

    const allocated = await tx.one(
      `SELECT COALESCE(sum(amount), 0)::text AS total
         FROM payment_allocations WHERE org_id = $1 AND invoice_id = $2`,
      [orgId, invoiceId],
    );

    const paid = toPaise(allocated.total);
    const total = toPaise(invoice.total);
    const due = Math.max(total - paid, 0);

    const status =
      invoice.status === 'void' ? 'void'
      : paid >= total ? 'paid'
      : paid > 0 ? 'partially_paid'
      : invoice.due_date && new Date(`${invoice.due_date}T00:00:00`) < new Date() ? 'overdue'
      : 'issued';

    return tx.one(
      `UPDATE invoices SET amount_paid = $3, amount_due = $4, status = $5
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [invoiceId, orgId, toRupees(paid), toRupees(due), status],
    );
  }

  // ═══════════════════════════════════════════════════════════════════ LIST
  app.get(
    '/invoicing/payments',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.payments.view')],
      schema: { querystring: query({ customer_id: v.id('cmp'), method: v.text(20) }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['received_on', 'created_at', 'amount'] });

      const where = ['p.org_id = $1'];
      const values = [orgId];
      if (request.query.customer_id) {
        values.push(request.query.customer_id);
        where.push(`p.customer_id = $${values.length}`);
      }
      if (request.query.method) {
        values.push(request.query.method);
        where.push(`p.method = $${values.length}`);
      }
      if (request.query.q) {
        values.push(`%${request.query.q}%`);
        where.push(`(p.number ILIKE $${values.length} OR p.reference ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT p.*, c.name AS customer_name,
                  (p.amount - p.allocated) AS unallocated
             FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
            WHERE ${clause} ORDER BY p.${page.orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM payments p WHERE ${clause}`, values),
      ]);

      return { data: rows, meta: page.meta(total.n) };
    },
  );

  // ═══════════════════════════════════════════════════════════════ RECORD
  /**
   * Records money received and matches it to invoices.
   *
   * With no explicit allocation the payment is applied oldest-invoice-first,
   * which is what a finance team does by hand. Anything left over stays on
   * account rather than being silently discarded.
   */
  app.post(
    '/invoicing/payments',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.payments.record')],
      schema: {
        body: body(
          {
            customer_id: v.id('cmp'),
            amount: v.money,
            method: v.enum(['cash', 'cheque', 'bank_transfer', 'upi', 'card', 'other']),
            reference: v.text(80),
            received_on: v.date,
            notes: v.text(500),
            allocations: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['invoice_id', 'amount'],
                properties: {
                  invoice_id: { type: 'string', pattern: '^inv_[0-9a-hjkmnp-tv-z]{26}$' },
                  amount: { type: ['string', 'number'] },
                },
              },
            },
          },
          ['amount'],
        ),
      },
    },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const b = request.body;

      const amount = toPaise(b.amount);
      if (amount <= 0) throw badRequest('A payment must be for more than zero.');

      const org = await settings.forOrg(orgId);

      const result = await db.transaction(async (tx) => {
        const assigned = await nextNumber(tx, {
          orgId, kind: 'payment',
          date: b.received_on ?? new Date(),
          fiscalYearStart: org.fiscal_year_start,
        });

        const payment = await tx.one(
          `INSERT INTO payments
             (id, org_id, number, customer_id, amount, currency, method, reference,
              received_on, notes, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'bank_transfer'),$8,
                   COALESCE($9::date, current_date),$10,$11)
           RETURNING *`,
          [
            id('pay'), orgId, assigned.number, b.customer_id ?? null, toRupees(amount),
            org.currency, b.method ?? null, b.reference ?? null, b.received_on ?? null,
            b.notes ?? null, userId,
          ],
        );

        // Explicit allocation, or oldest-first across this customer's dues.
        let plan = b.allocations;

        if (!plan?.length) {
          if (!b.customer_id) {
            throw badRequest(
              'Tell us which invoices this settles, or name a customer so we can apply it oldest-first.',
            );
          }
          const open = await tx.rows(
            `SELECT id, amount_due FROM invoices
              WHERE org_id = $1 AND customer_id = $2
                AND status IN ('issued','partially_paid','overdue') AND amount_due > 0
              ORDER BY due_date, created_at`,
            [orgId, b.customer_id],
          );

          plan = [];
          let remaining = amount;
          for (const invoice of open) {
            if (remaining <= 0) break;
            const due = toPaise(invoice.amount_due);
            const applied = Math.min(due, remaining);
            plan.push({ invoice_id: invoice.id, amount: toRupees(applied) });
            remaining -= applied;
          }
        }

        let allocated = 0;
        const settled = [];

        for (const item of plan) {
          const applied = toPaise(item.amount);
          if (applied <= 0) continue;

          const invoice = await tx.one(
            `SELECT * FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`,
            [item.invoice_id, orgId],
          );
          if (!invoice) throw notFound(`Invoice ${item.invoice_id}`);
          if (invoice.status === 'draft') {
            throw badRequest(`Invoice ${invoice.id} has not been issued yet.`);
          }
          if (invoice.status === 'void') {
            throw badRequest(`Invoice ${invoice.number} is void.`);
          }

          const due = toPaise(invoice.amount_due);
          if (applied > due) {
            throw badRequest(
              `₹${toRupees(applied)} allocated to ${invoice.number}, which only has ₹${toRupees(due)} outstanding.`,
              { invoice: invoice.number, outstanding: invoice.amount_due },
            );
          }

          allocated += applied;
          if (allocated > amount) {
            throw badRequest('The allocations add up to more than the payment.');
          }

          await tx.query(
            `INSERT INTO payment_allocations (id, org_id, payment_id, invoice_id, amount)
             VALUES ($1,$2,$3,$4,$5)`,
            [id('alc'), orgId, payment.id, invoice.id, toRupees(applied)],
          );

          const updated = await settle(tx, { orgId, invoiceId: invoice.id });
          settled.push(updated);

          if (updated.status === 'paid') {
            tx.emit({
              type: EVENTS.INVOICE_PAID,
              org_id: orgId,
              actor_id: userId,
              data: {
                invoice_id: updated.id, number: updated.number,
                customer_id: updated.customer_id, total: updated.total,
                paid_on: payment.received_on,
              },
            });
          }
        }

        const final = await tx.one(
          `UPDATE payments SET allocated = $3 WHERE id = $1 AND org_id = $2 RETURNING *`,
          [payment.id, orgId, toRupees(allocated)],
        );

        return { payment: final, settled, unallocated: amount - allocated };
      });

      return reply.status(201).send({
        data: {
          ...result.payment,
          unallocated: toRupees(result.unallocated),
          settled: result.settled.map((i) => ({
            id: i.id, number: i.number, status: i.status,
            amount_paid: i.amount_paid, amount_due: i.amount_due,
          })),
        },
      });
    },
  );

  app.get(
    '/invoicing/payments/:paymentId',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.payments.view')],
      schema: { params: params({ paymentId: v.id('pay') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const payment = await db.one(
        `SELECT p.*, c.name AS customer_name FROM payments p
           LEFT JOIN customers c ON c.id = p.customer_id
          WHERE p.id = $1 AND p.org_id = $2`,
        [request.params.paymentId, orgId],
      );
      if (!payment) throw notFound('Payment');

      const allocations = await db.rows(
        `SELECT a.*, i.number, i.total, i.status FROM payment_allocations a
           JOIN invoices i ON i.id = a.invoice_id
          WHERE a.org_id = $1 AND a.payment_id = $2`,
        [orgId, payment.id],
      );

      return {
        data: {
          ...payment,
          unallocated: toRupees(toPaise(payment.amount) - toPaise(payment.allocated)),
          allocations,
        },
      };
    },
  );

  // ═══════════════════════════════════════════════════════ OVERDUE SWEEP
  /**
   * Flips issued invoices past their due date to overdue. Idempotent, so it
   * is safe to call on a schedule or on demand.
   */
  app.post(
    '/invoicing/invoices/mark-overdue',
    { preHandler: [app.loadContext, requirePermission('invoicing.invoices.edit')] },
    async (request) => {
      const { orgId, userId } = request.ctx;

      const flipped = await db.transaction(async (tx) => {
        const rows = await tx.rows(
          `UPDATE invoices SET status = 'overdue'
            WHERE org_id = $1 AND status IN ('issued','partially_paid')
              AND due_date < current_date AND amount_due > 0
          RETURNING id, number, customer_id, customer_name, amount_due, due_date`,
          [orgId],
        );

        for (const invoice of rows) {
          tx.emit({
            type: EVENTS.INVOICE_OVERDUE,
            org_id: orgId,
            actor_id: userId,
            data: {
              invoice_id: invoice.id, number: invoice.number,
              customer_id: invoice.customer_id, customer_name: invoice.customer_name,
              amount_due: invoice.amount_due, due_date: invoice.due_date,
            },
          });
        }

        return rows;
      });

      return { data: { marked_overdue: flipped.length, invoices: flipped } };
    },
  );
}
