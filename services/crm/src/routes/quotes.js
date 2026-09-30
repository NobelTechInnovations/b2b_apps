import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, forbidden, resource, nullable, amount,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { sumLines, lineTotals, toRupees, nextSalesNumber, publicToken, internal, orgProfiles } from '../lib/sales.js';

const EDITABLE = ['draft', 'pending_approval', 'approved'];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date, n) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

const lineSchema = body({
  product_id: nullable(v.id('prd')), description: v.text(500, 1), quantity: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 },
  unit_price: amount, discount_percent: { type: 'number', minimum: 0, maximum: 100 }, tax_rate: { type: 'number', minimum: 0, maximum: 100 },
}, ['description', 'quantity', 'unit_price']);

/**
 * Quotations & Orders: build a quote, get big discounts approved, send the
 * customer a link they accept or decline themselves, and turn the accepted
 * quote into an order that delivers from stock and bills through Invoicing.
 */
export async function quoteRoutes(app) {
  const { db, config } = app;
  const call = internal(config);
  const orgProfile = orgProfiles(config);
  const guard = (permission) => [app.loadContext, requireApp('quotes'), requirePermission(permission)];
  const quoteParams = { params: params({ id: v.id('qt') }) };

  async function settings(store, orgId) {
    await store.query(`INSERT INTO sales_settings (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orgId]);
    return store.one(`SELECT * FROM sales_settings WHERE org_id = $1`, [orgId]);
  }

  app.get('/quotes/settings', { preHandler: guard('quotes.quotations.view') }, async (request) => ({ data: await settings(db, request.ctx.orgId) }));
  app.put('/quotes/settings', {
    preHandler: guard('quotes.quotations.approve'),
    schema: { body: body({ approval_discount_percent: { type: 'number', minimum: 0, maximum: 100 }, quote_validity_days: v.int(1, 365), default_terms: v.text(5000, 0) }) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const old = await settings(db, orgId);
    const next = { ...old, ...request.body };
    const row = await db.one(
      `UPDATE sales_settings SET approval_discount_percent = $2, quote_validity_days = $3, default_terms = $4, updated_by = $5, updated_at = now() WHERE org_id = $1 RETURNING *`,
      [orgId, next.approval_discount_percent, next.quote_validity_days, next.default_terms, userId],
    );
    return { data: row };
  });

  resource(app, {
    path: '/quotes/templates', table: 'quote_templates', prefix: 'qtpl', appSlug: 'quotes', label: 'Template',
    permissions: { view: 'quotes.quotations.view', manage: 'quotes.quotations.edit' },
    fields: { name: v.text(120, 1), title: v.text(200, 0), terms: v.text(5000, 0), notes: v.text(5000, 0), validity_days: v.int(1, 365), lines: { type: 'array', maxItems: 100, items: lineSchema } },
    required: ['name'], json: ['lines'], search: ['name'], defaultSort: 'name ASC',
  });

  // ── quotations ────────────────────────────────────────────────────────────
  async function quote(store, orgId, quoteId, lock = false) {
    const row = await store.one(`SELECT * FROM quotations WHERE org_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [orgId, quoteId]);
    if (!row) throw notFound('Quotation');
    return expire(store, row);
  }
  // A sent quote past its date is expired, whether or not anyone looked.
  async function expire(store, row) {
    if (row.status === 'sent' && String(row.valid_until).slice(0, 10) < today()) {
      await store.query(`UPDATE quotations SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'sent'`, [row.id]);
      return { ...row, status: 'expired' };
    }
    return row;
  }
  const quoteLines = (store, row) => store.rows(`SELECT * FROM quotation_lines WHERE org_id = $1 AND quotation_id = $2 ORDER BY position`, [row.org_id, row.id]);
  const full = async (store, row) => {
    const [lines, order] = await Promise.all([
      quoteLines(store, row),
      store.one(`SELECT id, number, status FROM sales_orders WHERE org_id = $1 AND quotation_id = $2`, [row.org_id, row.id]),
    ]);
    return { ...row, lines, order, public_url: `${config.appUrl}/q/${row.public_token}` };
  };

  async function writeLines(tx, orgId, row, lines) {
    if (!lines.length) throw badRequest('Add at least one line.');
    await tx.query(`DELETE FROM quotation_lines WHERE org_id = $1 AND quotation_id = $2`, [orgId, row.id]);
    for (const [position, line] of lines.entries()) {
      await tx.query(
        `INSERT INTO quotation_lines (id, org_id, quotation_id, position, product_id, description, quantity, unit_price, discount_percent, tax_rate, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id('qtl'), orgId, row.id, position, line.product_id ?? null, line.description.trim(), Number(line.quantity), toRupees(Math.round(Number(line.unit_price) * 100)),
          Number(line.discount_percent ?? 0), Number(line.tax_rate ?? 18), toRupees(lineTotals(line).total)],
      );
    }
    const t = sumLines(lines);
    await tx.query(
      `UPDATE quotations SET subtotal = $3, discount_total = $4, tax_total = $5, total = $6, max_discount = $7, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [orgId, row.id, t.subtotal, t.discount_total, t.tax_total, t.total, t.max_discount],
    );
  }

  async function assertLinks(tx, orgId, b) {
    const check = async (table, value, label) => {
      if (value && !(await tx.one(`SELECT 1 FROM ${table} WHERE org_id = $1 AND id = $2`, [orgId, value]))) throw badRequest(`Choose one of this workspace’s ${label}.`);
    };
    await check('companies', b.company_id, 'companies');
    await check('contacts', b.contact_id, 'contacts');
    await check('deals', b.deal_id, 'deals');
  }

  app.get('/quotes/quotations', {
    preHandler: guard('quotes.quotations.view'),
    schema: { querystring: query({ status: v.enum(['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired', 'converted', 'open']), mine: v.bool, deal_id: v.id('dea') }) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    await db.query(`UPDATE quotations SET status = 'expired', updated_at = now() WHERE org_id = $1 AND status = 'sent' AND valid_until < current_date`, [orgId]);
    const qs = request.query;
    const values = [orgId];
    const where = ['org_id = $1'];
    if (qs.status === 'open') where.push(`status IN ('draft', 'pending_approval', 'approved', 'sent')`);
    else if (qs.status) { values.push(qs.status); where.push(`status = $${values.length}`); }
    if (qs.mine) { values.push(userId); where.push(`owner_user_id = $${values.length}`); }
    if (qs.deal_id) { values.push(qs.deal_id); where.push(`deal_id = $${values.length}`); }
    if (qs.q) { values.push(`%${qs.q}%`); where.push(`(number ILIKE $${values.length} OR customer_name ILIKE $${values.length} OR title ILIKE $${values.length})`); }
    const limit = qs.limit ?? 25;
    const offset = ((qs.page ?? 1) - 1) * limit;
    const clause = where.join(' AND ');
    const [rows, total] = await Promise.all([
      db.rows(`SELECT * FROM quotations WHERE ${clause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, values),
      db.one(`SELECT count(*)::int AS n FROM quotations WHERE ${clause}`, values),
    ]);
    return { data: rows, meta: { total: total.n, page: qs.page ?? 1, limit, pages: Math.ceil(total.n / limit) || 1 } };
  });

  app.get('/quotes/quotations/:id', { preHandler: guard('quotes.quotations.view'), schema: quoteParams }, async (request) => {
    const row = await quote(db, request.ctx.orgId, request.params.id);
    return { data: await full(db, row) };
  });

  const quoteBody = {
    title: v.text(200, 0), company_id: nullable(v.id('cmp')), contact_id: nullable(v.id('con')), deal_id: nullable(v.id('dea')),
    customer_name: v.text(200, 1), customer_email: nullable(v.email), customer_gstin: nullable(v.text(15)),
    valid_until: v.date, terms: v.text(5000, 0), notes: v.text(5000, 0), template_id: v.id('qtpl'),
    lines: { type: 'array', minItems: 1, maxItems: 200, items: lineSchema },
  };

  app.post('/quotes/quotations', { preHandler: guard('quotes.quotations.create'), schema: { body: body(quoteBody, ['customer_name']) } }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      await assertLinks(tx, orgId, b);
      const s = await settings(tx, orgId);
      const template = b.template_id ? await tx.one(`SELECT * FROM quote_templates WHERE org_id = $1 AND id = $2`, [orgId, b.template_id]) : null;
      if (b.template_id && !template) throw badRequest('Choose one of this workspace’s templates.');
      const lines = b.lines ?? template?.lines ?? [];
      if (!lines.length) throw badRequest('Add at least one line.');
      const created = await tx.one(
        `INSERT INTO quotations (id, org_id, number, title, company_id, contact_id, deal_id, customer_name, customer_email, customer_gstin,
                                 valid_until, terms, notes, public_token, owner_user_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
        [id('qt'), orgId, await nextSalesNumber(tx, orgId, 'quote', 'QT'), b.title ?? template?.title ?? '', b.company_id ?? null, b.contact_id ?? null, b.deal_id ?? null,
          b.customer_name.trim(), b.customer_email?.toLowerCase() ?? null, b.customer_gstin ?? null,
          b.valid_until ?? addDays(today(), template?.validity_days ?? s.quote_validity_days), b.terms ?? template?.terms ?? s.default_terms, b.notes ?? template?.notes ?? '',
          publicToken(), userId],
      );
      await writeLines(tx, orgId, created, lines);
      return quote(tx, orgId, created.id);
    });
    return reply.status(201).send({ data: await full(db, row) });
  });

  app.patch('/quotes/quotations/:id', { preHandler: guard('quotes.quotations.edit'), schema: { ...quoteParams, body: body(quoteBody) } }, async (request) => {
    const { orgId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const old = await quote(tx, orgId, request.params.id, true);
      if (!EDITABLE.includes(old.status)) throw badRequest(`This quote is ${old.status}. Revise it to make changes.`);
      await assertLinks(tx, orgId, b);
      const next = { ...old, ...b };
      // Any edit sends an approved quote back to draft: approval was for what it said then.
      await tx.query(
        `UPDATE quotations SET title = $3, company_id = $4, contact_id = $5, deal_id = $6, customer_name = $7, customer_email = $8, customer_gstin = $9,
                valid_until = $10, terms = $11, notes = $12, status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, next.title, next.company_id, next.contact_id, next.deal_id, next.customer_name.trim(), next.customer_email?.toLowerCase() ?? null,
          next.customer_gstin, String(next.valid_until).slice(0, 10), next.terms, next.notes],
      );
      if (b.lines) await writeLines(tx, orgId, old, b.lines);
      return quote(tx, orgId, old.id);
    });
    return { data: await full(db, row) };
  });

  app.delete('/quotes/quotations/:id', { preHandler: guard('quotes.quotations.delete'), schema: quoteParams }, async (request) => {
    const { orgId } = request.ctx;
    const old = await quote(db, orgId, request.params.id);
    if (!['draft', 'pending_approval', 'approved', 'declined', 'expired'].includes(old.status)) throw badRequest('Sent, accepted and ordered quotes are kept.');
    await db.query(`DELETE FROM quotations WHERE org_id = $1 AND id = $2`, [orgId, old.id]);
    return { data: { deleted: true } };
  });

  const action = (path, permission, fn, schema) => app.post(`/quotes/quotations/:id/${path}`, {
    preHandler: guard(permission), schema: { ...quoteParams, ...(schema ? { body: schema } : {}) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const old = await quote(tx, orgId, request.params.id, true);
      await fn(tx, old, request.body ?? {}, request, userId);
      return quote(tx, orgId, old.id);
    });
    return { data: await full(db, row) };
  });

  // Submit: within the discount limit it is approved at once; beyond it, a
  // manager has to look.
  action('submit', 'quotes.quotations.edit', async (tx, q, b, request, userId) => {
    if (q.status !== 'draft') throw badRequest(`This quote is ${q.status.replace('_', ' ')}.`);
    const s = await settings(tx, q.org_id);
    if (Number(q.max_discount) > Number(s.approval_discount_percent)) {
      await tx.query(`UPDATE quotations SET status = 'pending_approval', updated_at = now() WHERE id = $1`, [q.id]);
      tx.emit({ type: EVENTS.QUOTE_APPROVAL_REQUESTED, org_id: q.org_id, actor_id: userId, data: { quotation_id: q.id, number: q.number, customer_name: q.customer_name, total: q.total, max_discount: q.max_discount } });
    } else {
      await tx.query(`UPDATE quotations SET status = 'approved', updated_at = now() WHERE id = $1`, [q.id]);
    }
  });

  action('approve', 'quotes.quotations.approve', async (tx, q, b, request, userId) => {
    if (q.status !== 'pending_approval') throw badRequest('Only a quote waiting for approval can be approved.');
    if (q.created_by === userId && !request.ctx.isOwner) throw forbidden('Someone else has to approve your own quote.');
    await tx.query(`UPDATE quotations SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [q.id, userId]);
  });

  action('reject-approval', 'quotes.quotations.approve', async (tx, q, b) => {
    if (q.status !== 'pending_approval') throw badRequest('Only a quote waiting for approval can be sent back.');
    await tx.query(`UPDATE quotations SET status = 'draft', notes = CASE WHEN $2 = '' THEN notes ELSE concat_ws(E'\\n', NULLIF(notes, ''), 'Approval note: ' || $2::text) END, updated_at = now() WHERE id = $1`, [q.id, b.note ?? '']);
  }, body({ note: v.text(1000, 0) }));

  action('send', 'quotes.quotations.send', async (tx, q, b, request, userId) => {
    if (q.status === 'draft') {
      const s = await settings(tx, q.org_id);
      if (Number(q.max_discount) > Number(s.approval_discount_percent)) throw badRequest(`A discount above ${Number(s.approval_discount_percent)}% needs approval first. Submit it for approval.`);
    } else if (!['approved', 'sent'].includes(q.status)) {
      throw badRequest(q.status === 'pending_approval' ? 'This quote is waiting for approval.' : `This quote is ${q.status}.`);
    }
    if (String(q.valid_until).slice(0, 10) < today()) throw badRequest('The validity date has passed. Change it before sending.');
    await tx.query(`UPDATE quotations SET status = 'sent', sent_at = COALESCE(sent_at, now()), updated_at = now() WHERE id = $1`, [q.id]);
    const link = `${config.appUrl}/q/${q.public_token}`;
    tx.emit({ type: EVENTS.QUOTE_SENT, org_id: q.org_id, actor_id: userId, data: { quotation_id: q.id, number: q.number, customer_name: q.customer_name, total: q.total, link } });
    if (q.customer_email && b.email !== false) {
      const org = await orgProfile(q.org_id);
      tx.emit({
        type: EVENTS.NOTIFICATION_REQUESTED, org_id: q.org_id, actor_id: userId,
        data: { channel: 'email', to: q.customer_email, template: 'quote', payload: { number: q.number, company: org.name, total: q.total, valid_until: String(q.valid_until).slice(0, 10), link, customer: q.customer_name } },
      });
    }
  }, body({ email: v.bool }));

  // Revise: a new version of a sent, declined or expired quote — the old link stops working.
  action('revise', 'quotes.quotations.edit', async (tx, q) => {
    if (!['sent', 'declined', 'expired', 'approved', 'pending_approval'].includes(q.status)) throw badRequest(`A quote that is ${q.status} cannot be revised.`);
    const s = await settings(tx, q.org_id);
    await tx.query(
      `UPDATE quotations SET status = 'draft', public_token = $2, approved_by = NULL, approved_at = NULL, sent_at = NULL, viewed_at = NULL,
              declined_at = NULL, decline_reason = NULL, valid_until = GREATEST(valid_until, current_date + $3::int), updated_at = now() WHERE id = $1`,
      [q.id, publicToken(), s.quote_validity_days],
    );
  });

  // Accepted → an order. One order per quote.
  app.post('/quotes/quotations/:id/order', { preHandler: guard('quotes.orders.create'), schema: quoteParams }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const order = await db.transaction(async (tx) => {
      const q = await quote(tx, orgId, request.params.id, true);
      if (q.status !== 'accepted') throw badRequest(q.status === 'converted' ? 'This quote is already an order.' : 'Only an accepted quote becomes an order.');
      const created = await tx.one(
        `INSERT INTO sales_orders (id, org_id, number, quotation_id, company_id, customer_name, customer_email, customer_gstin, subtotal, discount_total, tax_total, total, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [id('so'), orgId, await nextSalesNumber(tx, orgId, 'order', 'SO'), q.id, q.company_id, q.customer_name, q.customer_email, q.customer_gstin,
          q.subtotal, q.discount_total, q.tax_total, q.total, q.notes, userId],
      );
      for (const l of await quoteLines(tx, q)) {
        await tx.query(
          `INSERT INTO sales_order_lines (id, org_id, order_id, position, product_id, description, quantity, unit_price, discount_percent, tax_rate, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id('sol'), orgId, created.id, l.position, l.product_id, l.description, l.quantity, l.unit_price, l.discount_percent, l.tax_rate, l.line_total],
        );
      }
      await tx.query(`UPDATE quotations SET status = 'converted', updated_at = now() WHERE id = $1`, [q.id]);
      tx.emit({ type: EVENTS.ORDER_CONFIRMED, org_id: orgId, actor_id: userId, data: { order_id: created.id, number: created.number, quotation_number: q.number, customer_name: q.customer_name, total: q.total, owner_user_id: q.owner_user_id } });
      return created;
    });
    return reply.status(201).send({ data: order });
  });

  // ── orders ────────────────────────────────────────────────────────────────
  const orderParams = { params: params({ id: v.id('so') }) };
  async function order(store, orgId, orderId, lock = false) {
    const row = await store.one(`SELECT o.*, q.number AS quotation_number FROM sales_orders o LEFT JOIN quotations q ON q.id = o.quotation_id WHERE o.org_id = $1 AND o.id = $2${lock ? ' FOR UPDATE OF o' : ''}`, [orgId, orderId]);
    if (!row) throw notFound('Order');
    return row;
  }
  const orderLines = (store, row) => store.rows(`SELECT * FROM sales_order_lines WHERE org_id = $1 AND order_id = $2 ORDER BY position`, [row.org_id, row.id]);

  app.get('/quotes/orders', {
    preHandler: guard('quotes.orders.view'),
    schema: { querystring: query({ status: v.enum(['confirmed', 'delivered', 'invoiced', 'cancelled']) }) },
  }, async (request) => {
    const values = [request.ctx.orgId];
    const where = ['o.org_id = $1'];
    if (request.query.status) { values.push(request.query.status); where.push(`o.status = $${values.length}`); }
    if (request.query.q) { values.push(`%${request.query.q}%`); where.push(`(o.number ILIKE $${values.length} OR o.customer_name ILIKE $${values.length})`); }
    const rows = await db.rows(
      `SELECT o.*, q.number AS quotation_number FROM sales_orders o LEFT JOIN quotations q ON q.id = o.quotation_id WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT 200`,
      values,
    );
    return { data: rows };
  });

  app.get('/quotes/orders/:id', { preHandler: guard('quotes.orders.view'), schema: orderParams }, async (request) => {
    const row = await order(db, request.ctx.orgId, request.params.id);
    return { data: { ...row, lines: await orderLines(db, row) } };
  });

  app.post('/quotes/orders/:id/deliver', { preHandler: guard('quotes.orders.confirm'), schema: orderParams }, async (request) => {
    const { orgId, userId } = request.ctx;
    const o = await order(db, orgId, request.params.id);
    if (o.status !== 'confirmed') throw badRequest(`This order is ${o.status}.`);
    const lines = (await orderLines(db, o)).filter((l) => l.product_id);
    // With Inventory, delivering takes the goods out of stock first.
    if (lines.length && request.ctx.hasApp('erp')) {
      await call(`${config.erpUrl}/internal/erp/deliveries`, {
        method: 'POST',
        body: { org_id: orgId, actor_id: userId, reference: o.number, source_type: 'sales_order', source_id: o.id, lines: lines.map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) })) },
      });
    }
    const row = await db.one(`UPDATE sales_orders SET status = 'delivered', delivered_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'confirmed' RETURNING *`, [orgId, o.id]);
    return { data: row ?? await order(db, orgId, o.id) };
  });

  app.post('/quotes/orders/:id/invoice', { preHandler: guard('quotes.orders.confirm'), schema: orderParams }, async (request) => {
    const { orgId, userId } = request.ctx;
    if (!request.ctx.hasApp('invoicing')) throw badRequest('Turn on Invoicing to bill orders.');
    const o = await order(db, orgId, request.params.id);
    if (!['confirmed', 'delivered'].includes(o.status)) throw badRequest(o.status === 'invoiced' ? `Already invoiced as ${o.invoice_number}.` : `This order is ${o.status}.`);
    const lines = await orderLines(db, o);
    const invoice = await call(`${config.invoicingUrl}/internal/invoices`, {
      method: 'POST',
      body: {
        org_id: orgId, actor_id: userId, issue: true, source: 'quote', source_ref: o.id, reference: o.number,
        customer: { id: o.company_id ?? null, name: o.customer_name, gstin: o.customer_gstin ?? null, email: o.customer_email ?? null },
        lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unit_price: l.unit_price, discount_percent: Number(l.discount_percent), tax_rate: Number(l.tax_rate) })),
      },
    });
    const row = await db.one(
      `UPDATE sales_orders SET status = 'invoiced', invoice_id = $3, invoice_number = $4, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, o.id, invoice.id, invoice.number],
    );
    return { data: row };
  });

  app.post('/quotes/orders/:id/cancel', { preHandler: guard('quotes.orders.confirm'), schema: orderParams }, async (request) => {
    const row = await db.one(`UPDATE sales_orders SET status = 'cancelled', updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'confirmed' RETURNING *`, [request.ctx.orgId, request.params.id]);
    if (!row) throw badRequest('Only an order that has not been delivered or invoiced can be cancelled.');
    return { data: row };
  });

  // ── overview ──────────────────────────────────────────────────────────────
  async function stats(orgId) {
    return db.one(
      `SELECT COALESCE(sum(total) FILTER (WHERE status IN ('pending_approval', 'approved', 'sent')), 0)::numeric(14,2) AS open_value,
              count(*) FILTER (WHERE status = 'pending_approval')::int AS awaiting_approval,
              count(*) FILTER (WHERE status = 'sent')::int AS awaiting_customer,
              round(100.0 * count(*) FILTER (WHERE status IN ('accepted', 'converted') AND created_at > now() - interval '90 days')
                / NULLIF(count(*) FILTER (WHERE status IN ('accepted', 'converted', 'declined', 'expired') AND created_at > now() - interval '90 days'), 0))::int AS win_rate
         FROM quotations WHERE org_id = $1`,
      [orgId],
    );
  }
  app.get('/quotes/overview', { preHandler: guard('quotes.quotations.view') }, async (request) => ({ data: await stats(request.ctx.orgId) }));
  app.get('/quotes/widgets', { preHandler: guard('quotes.quotations.view') }, async (request) => {
    const s = await stats(request.ctx.orgId);
    return { data: { 'quotes.open_value': s.open_value, 'quotes.win_rate': s.win_rate === null ? '—' : `${s.win_rate}%` } };
  });

  // ══════════════════════════════════════════════════════ THE CUSTOMER'S PAGE
  const tokenParams = { params: { type: 'object', properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$' } }, required: ['token'] } };
  async function byToken(store, token, lock = false) {
    const row = await store.one(`SELECT * FROM quotations WHERE public_token = $1${lock ? ' FOR UPDATE' : ''}`, [token]);
    if (!row || ['draft', 'pending_approval', 'approved'].includes(row.status)) throw notFound('Quotation');
    return expire(store, row);
  }
  const customerView = async (row) => {
    const org = await orgProfile(row.org_id);
    const lines = await quoteLines(db, row);
    return {
      seller: { name: org.name, logo_url: org.logo_url ?? null, gstin: org.tax_id ?? null },
      number: row.number, title: row.title, status: row.status, customer_name: row.customer_name, issue_date: row.issue_date, valid_until: row.valid_until,
      subtotal: row.subtotal, discount_total: row.discount_total, tax_total: row.tax_total, total: row.total, terms: row.terms, notes: row.notes,
      accepted_by_name: row.accepted_by_name, accepted_at: row.accepted_at, declined_at: row.declined_at,
      lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, discount_percent: l.discount_percent, tax_rate: l.tax_rate, line_total: l.line_total })),
    };
  };

  app.get('/quote-view/:token', { schema: tokenParams }, async (request) => {
    const row = await byToken(db, request.params.token);
    if (row.status === 'sent' && !row.viewed_at) await db.query(`UPDATE quotations SET viewed_at = now() WHERE id = $1`, [row.id]);
    return { data: await customerView(row) };
  });

  app.post('/quote-view/:token/accept', { schema: { ...tokenParams, body: body({ name: v.text(120, 2) }, ['name']) } }, async (request) => {
    const row = await db.transaction(async (tx) => {
      const q = await byToken(tx, request.params.token, true);
      if (q.status !== 'sent') throw badRequest(q.status === 'expired' ? 'This quote has expired. Ask for a fresh one.' : `This quote is already ${q.status}.`);
      await tx.query(`UPDATE quotations SET status = 'accepted', accepted_at = now(), accepted_by_name = $2, updated_at = now() WHERE id = $1`, [q.id, request.body.name.trim()]);
      tx.emit({ type: EVENTS.QUOTE_ACCEPTED, org_id: q.org_id, actor_id: null, data: { quotation_id: q.id, number: q.number, customer_name: q.customer_name, accepted_by: request.body.name.trim(), total: q.total, owner_user_id: q.owner_user_id } });
      return byToken(tx, request.params.token);
    });
    return { data: await customerView(row) };
  });

  app.post('/quote-view/:token/decline', { schema: { ...tokenParams, body: body({ reason: v.text(1000, 0) }) } }, async (request) => {
    const row = await db.transaction(async (tx) => {
      const q = await byToken(tx, request.params.token, true);
      if (q.status !== 'sent') throw badRequest(`This quote is already ${q.status}.`);
      await tx.query(`UPDATE quotations SET status = 'declined', declined_at = now(), decline_reason = $2, updated_at = now() WHERE id = $1`, [q.id, request.body?.reason?.trim() || null]);
      tx.emit({ type: EVENTS.QUOTE_DECLINED, org_id: q.org_id, actor_id: null, data: { quotation_id: q.id, number: q.number, customer_name: q.customer_name, reason: request.body?.reason ?? null, owner_user_id: q.owner_user_id } });
      return byToken(tx, request.params.token);
    });
    return { data: await customerView(row) };
  });
}
