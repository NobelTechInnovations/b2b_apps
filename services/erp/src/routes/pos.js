import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, forbidden, resource, nullable, amount,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { nextNumber } from '../lib/numbers.js';
import { moveStock, warehouseOrDefault } from '../lib/stock.js';
import { toPaise, toRupees, lineTotals } from '../lib/money.js';

const qty = { type: 'number', exclusiveMinimum: 0, maximum: 100000 };

/**
 * Point of Sale. A register is a till tied to a warehouse; a session is one
 * shift at it, opened with a cash float and closed with a count. Sales are
 * idempotent on the till's own reference, so a sale rung up offline and sent
 * twice when the connection returns is still one sale.
 */
export async function posRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('pos'), requirePermission(permission)];

  const registers = resource(app, {
    path: '/pos/registers', table: 'pos_registers', prefix: 'reg', appSlug: 'pos', label: 'Register',
    permissions: { view: 'pos.registers.view', manage: 'pos.registers.manage' },
    fields: { name: v.text(80, 1), warehouse_id: nullable(v.id('wh')), receipt_footer: v.text(500, 0), active: v.bool },
    required: ['name'], search: ['name'], defaultSort: 'name ASC',
    columns: `t.*, w.name AS warehouse_name,
              (SELECT s.id FROM pos_sessions s WHERE s.org_id = t.org_id AND s.register_id = t.id AND s.status = 'open') AS open_session_id`,
    from: 'pos_registers t LEFT JOIN warehouses w ON w.id = t.warehouse_id',
    hooks: {
      async beforeCreate(tx, data, request) {
        const wh = await warehouseOrDefault(tx, request.ctx.orgId, data.warehouse_id);
        return { ...data, warehouse_id: wh.id };
      },
      async beforeUpdate(tx, data, old, request) {
        if (data.warehouse_id) await warehouseOrDefault(tx, request.ctx.orgId, data.warehouse_id);
        return data;
      },
      async beforeDelete(tx, old) {
        if (await tx.one(`SELECT 1 FROM pos_sessions WHERE org_id = $1 AND register_id = $2 LIMIT 1`, [old.org_id, old.id])) {
          throw badRequest('This register has sales history. Mark it inactive instead.');
        }
      },
    },
  });

  // ── sessions ──────────────────────────────────────────────────────────────
  const sessionParams = { params: params({ sessionId: v.id('pses') }) };
  async function session(store, orgId, sessionId, lock = false) {
    const row = await store.one(
      `SELECT s.*, r.name AS register_name, r.warehouse_id, r.receipt_footer FROM pos_sessions s JOIN pos_registers r ON r.id = s.register_id
        WHERE s.org_id = $1 AND s.id = $2${lock ? ' FOR UPDATE OF s' : ''}`,
      [orgId, sessionId],
    );
    if (!row) throw notFound('Session');
    return row;
  }
  const totals = (store, orgId, sessionId) => store.one(
    `SELECT count(*) FILTER (WHERE status = 'completed')::int AS sales,
            count(*) FILTER (WHERE status = 'refunded')::int AS refunds,
            COALESCE(sum(total) FILTER (WHERE status = 'completed'), 0)::numeric(14,2) AS revenue,
            COALESCE(sum(tax_total) FILTER (WHERE status = 'completed'), 0)::numeric(14,2) AS tax,
            COALESCE(sum(total) FILTER (WHERE status = 'completed' AND payment_method = 'cash'), 0)::numeric(14,2) AS cash,
            COALESCE(sum(total) FILTER (WHERE status = 'completed' AND payment_method = 'card'), 0)::numeric(14,2) AS card,
            COALESCE(sum(total) FILTER (WHERE status = 'completed' AND payment_method = 'upi'), 0)::numeric(14,2) AS upi,
            COALESCE(sum(total) FILTER (WHERE status = 'completed' AND payment_method = 'other'), 0)::numeric(14,2) AS other
       FROM pos_sales WHERE org_id = $1 AND session_id = $2`,
    [orgId, sessionId],
  );

  app.get('/pos/sessions', {
    preHandler: guard('pos.sessions.view'),
    schema: { querystring: query({ register_id: v.id('reg'), status: v.enum(['open', 'closed']) }) },
  }, async (request) => {
    const values = [request.ctx.orgId];
    const where = ['s.org_id = $1'];
    if (request.query.register_id) { values.push(request.query.register_id); where.push(`s.register_id = $${values.length}`); }
    if (request.query.status) { values.push(request.query.status); where.push(`s.status = $${values.length}`); }
    const rows = await db.rows(
      `SELECT s.*, r.name AS register_name,
              (SELECT count(*)::int FROM pos_sales x WHERE x.org_id = s.org_id AND x.session_id = s.id AND x.status = 'completed') AS sales,
              (SELECT COALESCE(sum(total), 0) FROM pos_sales x WHERE x.org_id = s.org_id AND x.session_id = s.id AND x.status = 'completed')::numeric(14,2) AS revenue
         FROM pos_sessions s JOIN pos_registers r ON r.id = s.register_id
        WHERE ${where.join(' AND ')} ORDER BY s.opened_at DESC LIMIT 100`,
      values,
    );
    return { data: rows };
  });

  app.get('/pos/sessions/:sessionId', { preHandler: guard('pos.sessions.view'), schema: sessionParams }, async (request) => {
    const row = await session(db, request.ctx.orgId, request.params.sessionId);
    return { data: { ...row, totals: await totals(db, row.org_id, row.id) } };
  });

  app.post('/pos/registers/:id/open', {
    preHandler: guard('pos.sessions.open'),
    schema: { params: params({ id: v.id('reg') }), body: body({ opening_cash: amount }) },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const register = await registers.load(db, orgId, request.params.id);
    if (!register.active) throw badRequest('This register is inactive.');
    try {
      const row = await db.one(
        `INSERT INTO pos_sessions (id, org_id, register_id, opened_by, opening_cash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [id('pses'), orgId, register.id, userId, toRupees(toPaise(request.body?.opening_cash ?? 0))],
      );
      return reply.status(201).send({ data: await session(db, orgId, row.id) });
    } catch (error) {
      if (error.name === 'UniqueViolation') throw badRequest('This register already has an open session.');
      throw error;
    }
  });

  app.post('/pos/sessions/:sessionId/close', {
    preHandler: guard('pos.sessions.close'),
    schema: { ...sessionParams, body: body({ counted_cash: amount, note: v.text(1000, 0) }, ['counted_cash']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const old = await session(tx, orgId, request.params.sessionId, true);
      if (old.status !== 'open') throw badRequest('This session is already closed.');
      const t = await totals(tx, orgId, old.id);
      const expected = toPaise(old.opening_cash) + toPaise(t.cash);
      await tx.query(
        `UPDATE pos_sessions SET status = 'closed', closed_by = $3, closed_at = now(), expected_cash = $4, counted_cash = $5, note = $6
          WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, userId, toRupees(expected), toRupees(toPaise(request.body.counted_cash)), request.body.note ?? ''],
      );
      return session(tx, orgId, old.id);
    });
    const t = await totals(db, orgId, row.id);
    return { data: { ...row, totals: t, difference: toRupees(toPaise(row.counted_cash) - toPaise(row.expected_cash)) } };
  });

  // What the till needs to start selling: the open session and the catalogue.
  app.get('/pos/registers/:id/till', { preHandler: guard('pos.sales.create'), schema: { params: params({ id: v.id('reg') }) } }, async (request) => {
    const { orgId } = request.ctx;
    const register = await registers.load(db, orgId, request.params.id);
    const open = register.open_session_id ? await session(db, orgId, register.open_session_id) : null;
    const products = await db.rows(
      `SELECT p.id, p.name, p.sku, p.barcode, p.uom, p.type, p.sale_price, p.tax_rate, p.image_url, c.name AS category_name,
              COALESCE((SELECT quantity FROM stock_quants q WHERE q.org_id = p.org_id AND q.product_id = p.id AND q.warehouse_id = $2), 0) AS on_hand
         FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
        WHERE p.org_id = $1 AND p.active ORDER BY c.name NULLS LAST, p.name LIMIT 1000`,
      [orgId, register.warehouse_id],
    );
    return { data: { register, session: open, products, totals: open ? await totals(db, orgId, open.id) : null } };
  });

  // ── sales ─────────────────────────────────────────────────────────────────
  async function sale(store, orgId, saleId, lock = false) {
    const row = await store.one(
      `SELECT s.*, r.name AS register_name, r.receipt_footer FROM pos_sales s JOIN pos_registers r ON r.id = s.register_id
        WHERE s.org_id = $1 AND s.id = $2${lock ? ' FOR UPDATE OF s' : ''}`,
      [orgId, saleId],
    );
    if (!row) throw notFound('Sale');
    return row;
  }
  const saleLines = (store, row) => store.rows(`SELECT * FROM pos_sale_lines WHERE org_id = $1 AND sale_id = $2 ORDER BY id`, [row.org_id, row.id]);

  app.post('/pos/sales', {
    preHandler: guard('pos.sales.create'),
    schema: {
      body: body({
        session_id: v.id('pses'), client_ref: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
        lines: { type: 'array', minItems: 1, maxItems: 200, items: body({ product_id: v.id('prd'), quantity: qty, discount_percent: { type: 'number', minimum: 0, maximum: 100 } }, ['product_id', 'quantity']) },
        payment_method: v.enum(['cash', 'card', 'upi', 'other']), amount_tendered: nullable(amount),
        customer_name: nullable(v.text(120)), customer_phone: nullable(v.text(32)),
        sold_at: v.datetime, offline: v.bool,
      }, ['session_id', 'client_ref', 'lines', 'payment_method']),
    },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const existing = await db.one(`SELECT id FROM pos_sales WHERE org_id = $1 AND client_ref = $2`, [orgId, b.client_ref]);
    if (existing) {
      const row = await sale(db, orgId, existing.id);
      return reply.status(200).send({ data: { ...row, lines: await saleLines(db, row), duplicate: true } });
    }
    const discountCap = request.ctx.can('pos.registers.manage') ? 100 : 20;
    try {
      const row = await db.transaction(async (tx) => {
        const s = await session(tx, orgId, b.session_id, true);
        if (s.status !== 'open' && !b.offline) throw badRequest('This session is closed. Open a new one to keep selling.');
        const priced = [];
        for (const line of b.lines) {
          const item = await tx.one(`SELECT * FROM products WHERE org_id = $1 AND id = $2`, [orgId, line.product_id]);
          if (!item) throw badRequest('A product in this sale no longer exists.');
          if ((line.discount_percent ?? 0) > discountCap) throw forbidden(`Discounts above ${discountCap}% need a manager.`);
          const full = { quantity: line.quantity, unit_price: item.sale_price, discount_percent: line.discount_percent ?? 0, tax_rate: Number(item.tax_rate) };
          priced.push({ item, full, t: lineTotals(full) });
        }
        const sum = priced.reduce((a, p) => ({ gross: a.gross + p.t.gross, discount: a.discount + p.t.discount, tax: a.tax + p.t.tax, total: a.total + p.t.total }), { gross: 0, discount: 0, tax: 0, total: 0 });
        const total = Math.round(sum.total / 100) * 100; // Rounded to the rupee, as tills do.
        let change = 0;
        if (b.payment_method === 'cash' && b.amount_tendered !== undefined && b.amount_tendered !== null) {
          const tendered = toPaise(b.amount_tendered);
          if (tendered < total) throw badRequest('The cash tendered is less than the total.');
          change = tendered - total;
        }
        const created = await tx.one(
          `INSERT INTO pos_sales (id, org_id, number, session_id, register_id, client_ref, customer_name, customer_phone, subtotal, discount_total,
                                  tax_total, total, payment_method, amount_tendered, change_due, sold_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16::timestamptz, now()),$17) RETURNING id`,
          [id('psale'), orgId, await nextNumber(tx, orgId, 'pos', 'POS', 6), s.id, s.register_id, b.client_ref, b.customer_name ?? null, b.customer_phone ?? null,
            toRupees(sum.gross), toRupees(sum.discount), toRupees(sum.tax), toRupees(total), b.payment_method,
            b.amount_tendered !== undefined && b.amount_tendered !== null ? toRupees(toPaise(b.amount_tendered)) : null, toRupees(change), b.sold_at ?? null, userId],
        );
        for (const p of priced) {
          await tx.query(
            `INSERT INTO pos_sale_lines (id, org_id, sale_id, product_id, name, quantity, unit_price, discount_percent, tax_rate, line_total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [id('psl'), orgId, created.id, p.item.id, p.item.name, p.full.quantity, p.item.sale_price, p.full.discount_percent, p.full.tax_rate, toRupees(p.t.total)],
          );
          if (p.item.type !== 'service') {
            await moveStock(tx, {
              orgId, userId, productId: p.item.id, fromWarehouseId: s.warehouse_id, quantity: p.full.quantity, kind: 'pos_sale',
              reference: s.register_name, sourceType: 'pos_sale', sourceId: created.id, allowNegative: Boolean(b.offline),
            });
          }
        }
        tx.emit({
          type: EVENTS.POS_SALE_COMPLETED, org_id: orgId, actor_id: userId,
          data: { sale_id: created.id, total: toRupees(total), tax_total: toRupees(sum.tax), payment_method: b.payment_method, register_id: s.register_id },
        });
        return sale(tx, orgId, created.id);
      });
      return reply.status(201).send({ data: { ...row, lines: await saleLines(db, row) } });
    } catch (error) {
      // Two syncs of the same offline sale racing each other: the second one
      // lost the unique race, and the first one's sale is the answer.
      if (error.name === 'UniqueViolation') {
        const again = await db.one(`SELECT id FROM pos_sales WHERE org_id = $1 AND client_ref = $2`, [orgId, b.client_ref]);
        if (again) {
          const row = await sale(db, orgId, again.id);
          return reply.status(200).send({ data: { ...row, lines: await saleLines(db, row), duplicate: true } });
        }
      }
      throw error;
    }
  });

  app.get('/pos/sales/:saleId', { preHandler: guard('pos.sales.create'), schema: { params: params({ saleId: v.id('psale') }) } }, async (request) => {
    const row = await sale(db, request.ctx.orgId, request.params.saleId);
    return { data: { ...row, lines: await saleLines(db, row) } };
  });

  app.post('/pos/sales/:saleId/refund', {
    preHandler: guard('pos.sales.refund'),
    schema: { params: params({ saleId: v.id('psale') }), body: body({ reason: v.text(500, 1) }, ['reason']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const old = await sale(tx, orgId, request.params.saleId, true);
      if (old.status === 'refunded') throw badRequest('This sale was already refunded.');
      const s = await session(tx, orgId, old.session_id);
      for (const line of await saleLines(tx, old)) {
        if (!line.product_id) continue;
        const item = await tx.one(`SELECT type FROM products WHERE id = $1`, [line.product_id]);
        if (!item || item.type === 'service') continue;
        await moveStock(tx, {
          orgId, userId, productId: line.product_id, toWarehouseId: s.warehouse_id, quantity: line.quantity, kind: 'pos_return',
          reference: old.number, sourceType: 'pos_sale', sourceId: old.id,
        });
      }
      await tx.query(
        `UPDATE pos_sales SET status = 'refunded', refund_reason = $3, refunded_by = $4, refunded_at = now() WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, request.body.reason.trim(), userId],
      );
      tx.emit({ type: EVENTS.POS_SALE_REFUNDED, org_id: orgId, actor_id: userId, data: { sale_id: old.id, number: old.number, total: old.total, tax_total: old.tax_total, payment_method: old.payment_method } });
      return sale(tx, orgId, old.id);
    });
    return { data: row };
  });

  // Reports: sales in a date range, by day, payment method and product.
  app.get('/pos/sales', {
    preHandler: guard('pos.reports.view'),
    schema: { querystring: query({ from: v.date, to: v.date, session_id: v.id('pses'), register_id: v.id('reg') }) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const from = request.query.from ?? new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const to = request.query.to ?? new Date().toISOString().slice(0, 10);
    const values = [orgId, from, to];
    const where = [`s.org_id = $1`, `s.sold_at >= $2::date`, `s.sold_at < $3::date + 1`];
    if (request.query.session_id) { values.push(request.query.session_id); where.push(`s.session_id = $${values.length}`); }
    if (request.query.register_id) { values.push(request.query.register_id); where.push(`s.register_id = $${values.length}`); }
    const clause = where.join(' AND ');
    const [rows, byDay, byMethod, top] = await Promise.all([
      db.rows(`SELECT s.*, r.name AS register_name FROM pos_sales s JOIN pos_registers r ON r.id = s.register_id WHERE ${clause} ORDER BY s.sold_at DESC LIMIT 200`, values),
      db.rows(`SELECT to_char(s.sold_at, 'YYYY-MM-DD') AS day, count(*)::int AS sales, sum(s.total)::numeric(14,2) AS revenue
                 FROM pos_sales s WHERE ${clause} AND s.status = 'completed' GROUP BY 1 ORDER BY 1`, values),
      db.rows(`SELECT s.payment_method, count(*)::int AS sales, sum(s.total)::numeric(14,2) AS revenue
                 FROM pos_sales s WHERE ${clause} AND s.status = 'completed' GROUP BY 1 ORDER BY 3 DESC`, values),
      db.rows(`SELECT l.name, sum(l.quantity)::numeric(14,3) AS quantity, sum(l.line_total)::numeric(14,2) AS revenue
                 FROM pos_sale_lines l JOIN pos_sales s ON s.id = l.sale_id WHERE ${clause} AND s.status = 'completed'
                GROUP BY l.name ORDER BY 3 DESC LIMIT 10`, values),
    ]);
    const revenue = byDay.reduce((sum, d) => sum + toPaise(d.revenue), 0);
    const count = byDay.reduce((sum, d) => sum + d.sales, 0);
    return {
      data: rows,
      meta: { from, to, revenue: toRupees(revenue), sales: count, average: toRupees(count ? revenue / count : 0), by_day: byDay, by_method: byMethod, top_products: top },
    };
  });

  app.get('/pos/widgets', { preHandler: guard('pos.sessions.view') }, async (request) => {
    const row = await db.one(
      `SELECT COALESCE(sum(total), 0)::numeric(14,2) AS revenue FROM pos_sales WHERE org_id = $1 AND status = 'completed' AND sold_at >= current_date`,
      [request.ctx.orgId],
    );
    return { data: { 'pos.today': row.revenue } };
  });
}
