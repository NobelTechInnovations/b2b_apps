import { paginate } from '@nexus/db-kit';
import { requirePermission, query, params, validate as v, notFound } from '@nexus/service-kit';

/**
 * Read-only. CRM owns customers; this is the projection invoicing keeps in
 * step via crm.customer.* events. Editing here would fork the truth.
 */
export async function customerRoutes(app) {
  const { db } = app;

  app.get(
    '/invoicing/customers',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.view')],
      schema: { querystring: query({}) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['name', 'created_at'] });

      const where = ['c.org_id = $1'];
      const values = [orgId];
      if (request.query.q) {
        values.push(`%${request.query.q}%`);
        where.push(`(c.name ILIKE $${values.length} OR c.gstin ILIKE $${values.length})`);
      }

      const clause = where.join(' AND ');

      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT c.*,
                  (SELECT COALESCE(sum(i.amount_due), 0)::text FROM invoices i
                    WHERE i.customer_id = c.id
                      AND i.status IN ('issued','partially_paid','overdue')) AS outstanding,
                  (SELECT count(*)::int FROM invoices i
                    WHERE i.customer_id = c.id AND i.status <> 'void') AS invoice_count
             FROM customers c WHERE ${clause}
            ORDER BY c.${page.orderBy === 'created_at DESC' ? 'name' : page.orderBy}
            LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM customers c WHERE ${clause}`, values),
      ]);

      return { data: rows, meta: page.meta(total.n) };
    },
  );

  app.get(
    '/invoicing/customers/:customerId',
    {
      preHandler: [app.loadContext, requirePermission('invoicing.invoices.view')],
      schema: { params: params({ customerId: v.id('cmp') }) },
    },
    async (request) => {
      const { orgId } = request.ctx;

      const customer = await db.one(`SELECT * FROM customers WHERE id = $1 AND org_id = $2`,
        [request.params.customerId, orgId]);
      if (!customer) throw notFound('Customer');

      const invoices = await db.rows(
        `SELECT id, number, status, issue_date, due_date, total, amount_due
           FROM invoices WHERE org_id = $1 AND customer_id = $2
          ORDER BY created_at DESC LIMIT 50`,
        [orgId, customer.id],
      );

      return { data: { ...customer, invoices } };
    },
  );
}
