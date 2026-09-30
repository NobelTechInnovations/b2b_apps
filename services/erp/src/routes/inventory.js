import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, resource, nullable, amount,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { moveStock, defaultWarehouse, warehouseOrDefault, product as loadProduct } from '../lib/stock.js';
import { nextNumber } from '../lib/numbers.js';
import { toPaise, toRupees, lineTotals, sumLines } from '../lib/money.js';
import { createChecks } from '../lib/quality.js';

const qty = { anyOf: [{ type: 'number', exclusiveMinimum: 0, maximum: 1e9 }, { type: 'string', pattern: '^\\d+(\\.\\d{1,3})?$' }] };

/**
 * Inventory & Purchasing: the catalogue, the warehouses, what is on the
 * shelves, and the purchase orders that fill them.
 */
export async function inventoryRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('erp'), requirePermission(permission)];

  // ── categories ────────────────────────────────────────────────────────────
  resource(app, {
    path: '/erp/categories', table: 'product_categories', prefix: 'pcat', appSlug: 'erp', label: 'Category',
    permissions: { view: 'erp.products.view', manage: 'erp.products.edit' },
    fields: { name: v.text(80, 1), description: v.text(500, 0) },
    required: ['name'], search: ['name'], defaultSort: 'name ASC', sorts: ['name'],
    uniqueMessage: 'A category with that name already exists.',
    columns: 't.*, (SELECT count(*)::int FROM products p WHERE p.org_id = t.org_id AND p.category_id = t.id) AS product_count',
  });

  // ── products ──────────────────────────────────────────────────────────────
  const products = resource(app, {
    path: '/erp/products', table: 'products', prefix: 'prd', appSlug: 'erp', label: 'Product',
    permissions: { view: 'erp.products.view', create: 'erp.products.create', edit: 'erp.products.edit', delete: 'erp.products.delete' },
    fields: {
      sku: nullable(v.text(60, 1)), name: v.text(200, 1), description: v.text(5000, 0),
      category_id: nullable(v.id('pcat')), type: v.enum(['stockable', 'consumable', 'service']), uom: v.text(20, 1),
      barcode: nullable(v.text(64, 1)), hsn_sac: nullable(v.text(12, 1)),
      sale_price: amount, cost_price: amount, tax_rate: { type: 'number', minimum: 0, maximum: 100 },
      reorder_level: { type: 'number', minimum: 0 }, active: v.bool, online: v.bool,
      image_url: nullable({ type: 'string', format: 'uri', maxLength: 1000 }),
    },
    required: ['name'],
    search: ['name', 'sku', 'barcode'],
    filters: { type: v.enum(['stockable', 'consumable', 'service']), category_id: v.id('pcat'), active: v.bool, online: v.bool },
    sorts: ['name', 'sku', 'sale_price', 'created_at'],
    defaultSort: 'name ASC',
    uniqueMessage: 'Another product already uses that SKU or barcode.',
    columns: `t.*, c.name AS category_name,
              COALESCE((SELECT sum(q.quantity) FROM stock_quants q WHERE q.org_id = t.org_id AND q.product_id = t.id), 0) AS on_hand`,
    from: 'products t LEFT JOIN product_categories c ON c.org_id = t.org_id AND c.id = t.category_id',
    hooks: {
      async beforeCreate(tx, data, request) {
        if (data.category_id) await assertCategory(tx, request.ctx.orgId, data.category_id);
        return data;
      },
      async beforeUpdate(tx, data, old, request) {
        if (data.category_id) await assertCategory(tx, request.ctx.orgId, data.category_id);
        if (data.type && data.type !== old.type) {
          const moved = await tx.one(`SELECT 1 FROM stock_moves WHERE org_id = $1 AND product_id = $2 LIMIT 1`, [old.org_id, old.id]);
          if (moved) throw badRequest('This product already has stock history, so its type cannot change. Archive it and create a new one.');
        }
        return data;
      },
      async beforeDelete(tx, old) {
        const used = await tx.one(`SELECT 1 FROM stock_moves WHERE org_id = $1 AND product_id = $2 LIMIT 1`, [old.org_id, old.id]);
        if (used) throw badRequest('This product has stock history. Archive it (untick Active) instead of deleting it.');
      },
      async detail(store, row) {
        const [stock, moves] = await Promise.all([
          store.rows(
            `SELECT w.id AS warehouse_id, w.name AS warehouse_name, COALESCE(q.quantity, 0) AS quantity
               FROM warehouses w LEFT JOIN stock_quants q ON q.org_id = w.org_id AND q.warehouse_id = w.id AND q.product_id = $2
              WHERE w.org_id = $1 AND w.active ORDER BY w.is_default DESC, w.name`,
            [row.org_id, row.id],
          ),
          store.rows(
            `SELECT m.*, fw.name AS from_name, tw.name AS to_name FROM stock_moves m
               LEFT JOIN warehouses fw ON fw.id = m.from_warehouse_id LEFT JOIN warehouses tw ON tw.id = m.to_warehouse_id
              WHERE m.org_id = $1 AND m.product_id = $2 ORDER BY m.created_at DESC LIMIT 25`,
            [row.org_id, row.id],
          ),
        ]);
        return { ...row, stock, moves };
      },
    },
  });
  async function assertCategory(tx, orgId, categoryId) {
    const row = await tx.one(`SELECT 1 FROM product_categories WHERE org_id = $1 AND id = $2`, [orgId, categoryId]);
    if (!row) throw badRequest('Choose one of this workspace’s categories.');
  }

  // Scanning a barcode at the till or in the stock room.
  app.get('/erp/products/lookup/:code', {
    preHandler: [app.loadContext, requirePermission('erp.products.view')],
    schema: { params: params({ code: v.text(64, 1) }) },
  }, async (request) => {
    const row = await db.one(
      `SELECT * FROM products WHERE org_id = $1 AND active AND (barcode = $2 OR lower(sku) = lower($2)) LIMIT 1`,
      [request.ctx.orgId, request.params.code],
    );
    if (!row) throw notFound('Product');
    return { data: row };
  });

  // ── warehouses ────────────────────────────────────────────────────────────
  resource(app, {
    path: '/erp/warehouses', table: 'warehouses', prefix: 'wh', appSlug: 'erp', label: 'Warehouse',
    permissions: { view: 'erp.inventory.view', manage: 'erp.warehouses.manage' },
    fields: { code: v.text(12, 1), name: v.text(120, 1), address: v.text(500, 0), active: v.bool },
    required: ['code', 'name'], search: ['name', 'code'], defaultSort: 'is_default DESC, name ASC',
    uniqueMessage: 'Another warehouse uses that code.',
    columns: `t.*, COALESCE((SELECT sum(q.quantity * p.cost_price) FROM stock_quants q JOIN products p ON p.id = q.product_id
                             WHERE q.org_id = t.org_id AND q.warehouse_id = t.id), 0)::numeric(14,2) AS stock_value`,
    hooks: {
      // The first look at warehouses creates the default one.
      beforeList: (request) => defaultWarehouse(db, request.ctx.orgId),
      async beforeCreate(tx, data) { return { ...data, code: data.code.toUpperCase() }; },
      async beforeUpdate(tx, data, old) {
        if (data.active === false && old.is_default) throw badRequest('The default warehouse cannot be archived.');
        return data.code ? { ...data, code: data.code.toUpperCase() } : data;
      },
      async beforeDelete(tx, old) {
        if (old.is_default) throw badRequest('The default warehouse cannot be deleted.');
        const stocked = await tx.one(`SELECT 1 FROM stock_quants WHERE org_id = $1 AND warehouse_id = $2 AND quantity <> 0 LIMIT 1`, [old.org_id, old.id]);
        if (stocked) throw badRequest('This warehouse still holds stock. Transfer it out first.');
      },
    },
  });

  // ── stock ─────────────────────────────────────────────────────────────────
  app.get('/erp/stock', {
    preHandler: guard('erp.inventory.view'),
    schema: { querystring: query({ warehouse_id: v.id('wh'), low: v.bool, category_id: v.id('pcat') }) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const qs = request.query;
    const values = [orgId, qs.warehouse_id ?? null];
    const where = [`p.org_id = $1`, `p.type = 'stockable'`, `p.active`];
    if (qs.category_id) { values.push(qs.category_id); where.push(`p.category_id = $${values.length}`); }
    if (qs.q) { values.push(`%${qs.q}%`); where.push(`(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length} OR p.barcode ILIKE $${values.length})`); }
    const rows = await db.rows(
      `SELECT p.id, p.sku, p.name, p.uom, p.cost_price, p.sale_price, p.reorder_level, c.name AS category_name,
              COALESCE((SELECT sum(q.quantity) FROM stock_quants q WHERE q.org_id = p.org_id AND q.product_id = p.id
                         AND ($2::text IS NULL OR q.warehouse_id = $2)), 0) AS on_hand
         FROM products p LEFT JOIN product_categories c ON c.org_id = p.org_id AND c.id = p.category_id
        WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 500`,
      values,
    );
    const data = rows
      .map((r) => ({ ...r, value: toRupees(toPaise(r.cost_price) * Number(r.on_hand)), low: Number(r.reorder_level) > 0 && Number(r.on_hand) <= Number(r.reorder_level) }))
      .filter((r) => !qs.low || r.low);
    const total = data.reduce((sum, r) => sum + toPaise(r.value), 0);
    return { data, meta: { total_value: toRupees(total), low_count: data.filter((r) => r.low).length } };
  });

  app.get('/erp/moves', {
    preHandler: guard('erp.inventory.view'),
    schema: { querystring: query({ product_id: v.id('prd'), kind: v.text(20) }) },
  }, async (request) => {
    const values = [request.ctx.orgId];
    const where = ['m.org_id = $1'];
    if (request.query.product_id) { values.push(request.query.product_id); where.push(`m.product_id = $${values.length}`); }
    if (request.query.kind) { values.push(request.query.kind); where.push(`m.kind = $${values.length}`); }
    const limit = request.query.limit ?? 50;
    const offset = ((request.query.page ?? 1) - 1) * limit;
    const rows = await db.rows(
      `SELECT m.*, p.name AS product_name, p.sku, p.uom, fw.name AS from_name, tw.name AS to_name
         FROM stock_moves m JOIN products p ON p.id = m.product_id
         LEFT JOIN warehouses fw ON fw.id = m.from_warehouse_id LEFT JOIN warehouses tw ON tw.id = m.to_warehouse_id
        WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      values,
    );
    return { data: rows };
  });

  // A stock count: record what is actually on the shelf; the difference is
  // booked as an adjustment so the history explains the change.
  app.post('/erp/stock/adjust', {
    preHandler: guard('erp.inventory.adjust'),
    schema: { body: body({ product_id: v.id('prd'), warehouse_id: v.id('wh'), counted_quantity: { type: 'number', minimum: 0 }, note: v.text(500, 0) }, ['product_id', 'counted_quantity']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const result = await db.transaction(async (tx) => {
      const wh = await warehouseOrDefault(tx, orgId, b.warehouse_id);
      const item = await loadProduct(tx, orgId, b.product_id);
      if (item.type !== 'stockable') throw badRequest('Only stockable products are counted.');
      await tx.query(`INSERT INTO stock_quants (org_id, product_id, warehouse_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [orgId, item.id, wh.id]);
      const quant = await tx.one(`SELECT quantity FROM stock_quants WHERE org_id = $1 AND product_id = $2 AND warehouse_id = $3 FOR UPDATE`, [orgId, item.id, wh.id]);
      const diff = Number(b.counted_quantity) - Number(quant.quantity);
      if (diff === 0) return { changed: false, on_hand: Number(quant.quantity) };
      await moveStock(tx, {
        orgId, userId, productId: item.id, quantity: Math.abs(diff), kind: diff > 0 ? 'adjustment_in' : 'adjustment_out',
        fromWarehouseId: diff < 0 ? wh.id : null, toWarehouseId: diff > 0 ? wh.id : null, reference: 'Stock count', note: b.note || null,
      });
      return { changed: true, difference: diff, on_hand: Number(b.counted_quantity) };
    });
    return { data: result };
  });

  app.post('/erp/stock/transfer', {
    preHandler: guard('erp.inventory.adjust'),
    schema: { body: body({ product_id: v.id('prd'), from_warehouse_id: v.id('wh'), to_warehouse_id: v.id('wh'), quantity: qty, note: v.text(500, 0) }, ['product_id', 'from_warehouse_id', 'to_warehouse_id', 'quantity']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    if (b.from_warehouse_id === b.to_warehouse_id) throw badRequest('Choose two different warehouses.');
    const move = await db.transaction(async (tx) => {
      await warehouseOrDefault(tx, orgId, b.from_warehouse_id);
      await warehouseOrDefault(tx, orgId, b.to_warehouse_id);
      return moveStock(tx, {
        orgId, userId, productId: b.product_id, quantity: b.quantity, kind: 'transfer',
        fromWarehouseId: b.from_warehouse_id, toWarehouseId: b.to_warehouse_id, reference: 'Transfer', note: b.note || null,
      });
    });
    return { data: move };
  });

  // ── vendors ───────────────────────────────────────────────────────────────
  resource(app, {
    path: '/erp/vendors', table: 'vendors', prefix: 'vnd', appSlug: 'erp', label: 'Vendor',
    permissions: { view: 'erp.vendors.view', manage: 'erp.vendors.manage' },
    fields: {
      name: v.text(160, 1), contact_name: nullable(v.text(120)), email: nullable(v.email), phone: nullable(v.text(32)),
      gstin: nullable({ type: 'string', pattern: '^[0-9]{2}[A-Z0-9]{13}$' }), address: v.text(1000, 0),
      payment_terms_days: v.int(0, 365), notes: v.text(5000, 0), active: v.bool,
    },
    required: ['name'], search: ['name', 'contact_name', 'email', 'phone', 'gstin'], filters: { active: v.bool },
    sorts: ['name', 'created_at'], defaultSort: 'name ASC',
    uniqueMessage: 'A vendor with that name already exists.',
    columns: `t.*, (SELECT count(*)::int FROM purchase_orders po WHERE po.org_id = t.org_id AND po.vendor_id = t.id) AS order_count,
              (SELECT COALESCE(sum(po.total), 0) FROM purchase_orders po WHERE po.org_id = t.org_id AND po.vendor_id = t.id AND po.status <> 'cancelled') AS total_ordered`,
    hooks: {
      async beforeDelete(tx, old) {
        const used = await tx.one(`SELECT 1 FROM purchase_orders WHERE org_id = $1 AND vendor_id = $2 LIMIT 1`, [old.org_id, old.id]);
        if (used) throw badRequest('This vendor has purchase orders. Mark it inactive instead.');
      },
    },
  });

  // ── purchase orders ───────────────────────────────────────────────────────
  const lineSchema = body({
    product_id: v.id('prd'), description: v.text(500, 0), quantity: qty, unit_price: amount,
    tax_rate: { type: 'number', minimum: 0, maximum: 100 },
  }, ['product_id', 'quantity']);
  const poParams = { params: params({ poId: v.id('po') }) };

  async function po(store, orgId, poId, lock = false) {
    const row = await store.one(
      `SELECT po.*, v.name AS vendor_name, w.name AS warehouse_name FROM purchase_orders po
         JOIN vendors v ON v.id = po.vendor_id LEFT JOIN warehouses w ON w.id = po.warehouse_id
        WHERE po.org_id = $1 AND po.id = $2${lock ? ' FOR UPDATE OF po' : ''}`,
      [orgId, poId],
    );
    if (!row) throw notFound('Purchase order');
    return row;
  }
  const poLines = (store, row) => store.rows(
    `SELECT l.*, p.name AS product_name, p.sku, p.uom, p.type AS product_type FROM purchase_order_lines l JOIN products p ON p.id = l.product_id
      WHERE l.org_id = $1 AND l.po_id = $2 ORDER BY l.position`,
    [row.org_id, row.id],
  );

  async function writeLines(tx, orgId, row, lines) {
    if (!lines.length) throw badRequest('Add at least one product.');
    await tx.query(`DELETE FROM purchase_order_lines WHERE org_id = $1 AND po_id = $2`, [orgId, row.id]);
    const priced = [];
    for (const [index, line] of lines.entries()) {
      const item = await loadProduct(tx, orgId, line.product_id);
      const full = {
        quantity: Number(line.quantity), unit_price: line.unit_price ?? item.cost_price,
        tax_rate: line.tax_rate ?? Number(item.tax_rate), discount_percent: 0,
      };
      priced.push(full);
      await tx.query(
        `INSERT INTO purchase_order_lines (id, org_id, po_id, position, product_id, description, quantity, unit_price, tax_rate, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id('pol'), orgId, row.id, index, item.id, line.description || item.name, full.quantity,
          toRupees(toPaise(full.unit_price)), full.tax_rate, toRupees(lineTotals(full).total)],
      );
    }
    const t = sumLines(priced);
    await tx.query(
      `UPDATE purchase_orders SET subtotal = $3, tax_total = $4, total = $5, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [orgId, row.id, toRupees(t.subtotal - t.discount), toRupees(t.tax), toRupees(t.total)],
    );
  }

  async function assertVendor(tx, orgId, vendorId) {
    const vendor = await tx.one(`SELECT * FROM vendors WHERE org_id = $1 AND id = $2`, [orgId, vendorId]);
    if (!vendor) throw badRequest('Choose one of this workspace’s vendors.');
    if (!vendor.active) throw badRequest(`${vendor.name} is inactive.`);
    return vendor;
  }

  app.get('/erp/purchase-orders', {
    preHandler: guard('erp.purchase.view'),
    schema: { querystring: query({ status: v.enum(['draft', 'approved', 'partially_received', 'received', 'cancelled', 'open']), vendor_id: v.id('vnd') }) },
  }, async (request) => {
    const qs = request.query;
    const values = [request.ctx.orgId];
    const where = ['po.org_id = $1'];
    if (qs.status === 'open') where.push(`po.status IN ('draft', 'approved', 'partially_received')`);
    else if (qs.status) { values.push(qs.status); where.push(`po.status = $${values.length}`); }
    if (qs.vendor_id) { values.push(qs.vendor_id); where.push(`po.vendor_id = $${values.length}`); }
    if (qs.q) { values.push(`%${qs.q}%`); where.push(`(po.number ILIKE $${values.length} OR v.name ILIKE $${values.length})`); }
    const limit = qs.limit ?? 25;
    const offset = ((qs.page ?? 1) - 1) * limit;
    const clause = where.join(' AND ');
    const [rows, total] = await Promise.all([
      db.rows(
        `SELECT po.*, v.name AS vendor_name FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
          WHERE ${clause} ORDER BY po.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        values,
      ),
      db.one(`SELECT count(*)::int AS n FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE ${clause}`, values),
    ]);
    return { data: rows, meta: { total: total.n, page: qs.page ?? 1, limit, pages: Math.ceil(total.n / limit) || 1 } };
  });

  app.get('/erp/purchase-orders/:poId', { preHandler: guard('erp.purchase.view'), schema: poParams }, async (request) => {
    const row = await po(db, request.ctx.orgId, request.params.poId);
    return { data: { ...row, lines: await poLines(db, row) } };
  });

  app.post('/erp/purchase-orders', {
    preHandler: guard('erp.purchase.create'),
    schema: {
      body: body({
        vendor_id: v.id('vnd'), warehouse_id: nullable(v.id('wh')), order_date: v.date, expected_date: nullable(v.date),
        notes: v.text(5000, 0), lines: { type: 'array', items: lineSchema, minItems: 1, maxItems: 200 },
      }, ['vendor_id', 'lines']),
    },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      await assertVendor(tx, orgId, b.vendor_id);
      const wh = await warehouseOrDefault(tx, orgId, b.warehouse_id);
      const created = await tx.one(
        `INSERT INTO purchase_orders (id, org_id, number, vendor_id, warehouse_id, order_date, expected_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, current_date),$7,$8,$9) RETURNING *`,
        [id('po'), orgId, await nextNumber(tx, orgId, 'po', 'PO'), b.vendor_id, wh.id, b.order_date ?? null, b.expected_date ?? null, b.notes ?? '', userId],
      );
      await writeLines(tx, orgId, created, b.lines);
      return po(tx, orgId, created.id);
    });
    return reply.status(201).send({ data: { ...row, lines: await poLines(db, row) } });
  });

  app.patch('/erp/purchase-orders/:poId', {
    preHandler: guard('erp.purchase.create'),
    schema: {
      ...poParams,
      body: body({
        vendor_id: v.id('vnd'), warehouse_id: nullable(v.id('wh')), order_date: v.date, expected_date: nullable(v.date),
        notes: v.text(5000, 0), lines: { type: 'array', items: lineSchema, minItems: 1, maxItems: 200 },
      }),
    },
  }, async (request) => {
    const { orgId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const old = await po(tx, orgId, request.params.poId, true);
      if (old.status !== 'draft') throw badRequest('Only a draft purchase order can be edited.');
      if (b.vendor_id) await assertVendor(tx, orgId, b.vendor_id);
      const wh = b.warehouse_id !== undefined ? await warehouseOrDefault(tx, orgId, b.warehouse_id) : null;
      await tx.query(
        `UPDATE purchase_orders SET vendor_id = COALESCE($3, vendor_id), warehouse_id = COALESCE($4, warehouse_id),
                order_date = COALESCE($5::date, order_date), expected_date = CASE WHEN $8 THEN $6::date ELSE expected_date END,
                notes = COALESCE($7, notes), updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, b.vendor_id ?? null, wh?.id ?? null, b.order_date ?? null, b.expected_date ?? null, b.notes ?? null, 'expected_date' in b],
      );
      if (b.lines) await writeLines(tx, orgId, old, b.lines);
      return po(tx, orgId, old.id);
    });
    return { data: { ...row, lines: await poLines(db, row) } };
  });

  app.post('/erp/purchase-orders/:poId/approve', { preHandler: guard('erp.purchase.approve'), schema: poParams }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const old = await po(tx, orgId, request.params.poId, true);
      if (old.status !== 'draft') throw badRequest(`This order is ${old.status.replace('_', ' ')}.`);
      await tx.query(`UPDATE purchase_orders SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, old.id, userId]);
      return po(tx, orgId, old.id);
    });
    return { data: row };
  });

  app.post('/erp/purchase-orders/:poId/cancel', { preHandler: guard('erp.purchase.approve'), schema: poParams }, async (request) => {
    const { orgId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const old = await po(tx, orgId, request.params.poId, true);
      if (!['draft', 'approved'].includes(old.status)) throw badRequest('Goods have been received on this order; it can no longer be cancelled.');
      await tx.query(`UPDATE purchase_orders SET status = 'cancelled', updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, old.id]);
      return po(tx, orgId, old.id);
    });
    return { data: row };
  });

  app.delete('/erp/purchase-orders/:poId', { preHandler: guard('erp.purchase.create'), schema: poParams }, async (request) => {
    const { orgId } = request.ctx;
    await db.transaction(async (tx) => {
      const old = await po(tx, orgId, request.params.poId, true);
      if (old.status !== 'draft') throw badRequest('Only drafts can be deleted. Cancel the order instead.');
      await tx.query(`DELETE FROM purchase_orders WHERE org_id = $1 AND id = $2`, [orgId, old.id]);
    });
    return { data: { deleted: true } };
  });

  // Receiving: all that is outstanding, or specific quantities per line. Each
  // receipt is a stock move, and the order's status follows what has arrived.
  app.post('/erp/purchase-orders/:poId/receive', {
    preHandler: guard('erp.inventory.adjust'),
    schema: {
      ...poParams,
      body: body({ lines: { type: 'array', maxItems: 200, items: body({ line_id: v.id('pol'), quantity: qty }, ['line_id', 'quantity']) } }),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const result = await db.transaction(async (tx) => {
      const order = await po(tx, orgId, request.params.poId, true);
      if (!['approved', 'partially_received'].includes(order.status)) {
        throw badRequest(order.status === 'draft' ? 'Approve the purchase order before receiving goods.' : `This order is ${order.status.replace('_', ' ')}.`);
      }
      const lines = await poLines(tx, order);
      const wanted = request.body?.lines?.length
        ? new Map(request.body.lines.map((l) => [l.line_id, Number(l.quantity)]))
        : new Map(lines.map((l) => [l.id, Number(l.quantity) - Number(l.received_quantity)]));

      let receivedValue = 0;
      let receivedTax = 0;
      const received = [];
      for (const line of lines) {
        const take = wanted.get(line.id);
        if (!take) continue;
        const outstanding = Number(line.quantity) - Number(line.received_quantity);
        if (take > outstanding + 1e-9) throw badRequest(`Only ${outstanding} of ${line.product_name} is still to come.`);
        if (line.product_type !== 'service') {
          await moveStock(tx, {
            orgId, userId, productId: line.product_id, toWarehouseId: order.warehouse_id ?? (await defaultWarehouse(tx, orgId)).id,
            quantity: take, kind: 'receipt', reference: order.number, sourceType: 'purchase_order', sourceId: order.id, unitCost: line.unit_price,
          });
        }
        await tx.query(`UPDATE purchase_order_lines SET received_quantity = received_quantity + $3 WHERE org_id = $1 AND id = $2`, [orgId, line.id, take]);
        const worth = lineTotals({ quantity: take, unit_price: line.unit_price, tax_rate: line.tax_rate });
        receivedValue += worth.total;
        receivedTax += worth.tax;
        received.push({ product_id: line.product_id, quantity: take });
      }
      if (!received.length) throw badRequest('Nothing to receive.');

      const after = await tx.one(
        `SELECT bool_and(received_quantity >= quantity) AS complete FROM purchase_order_lines WHERE org_id = $1 AND po_id = $2`,
        [orgId, order.id],
      );
      await tx.query(
        `UPDATE purchase_orders SET status = $3, received_at = CASE WHEN $3 = 'received' THEN now() ELSE received_at END, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, order.id, after.complete ? 'received' : 'partially_received'],
      );
      await createChecks(tx, { orgId, userId, trigger: 'receipt', items: received, sourceType: 'purchase_order', sourceId: order.id, sourceRef: order.number });
      tx.emit({
        type: EVENTS.PURCHASE_RECEIVED, org_id: orgId, actor_id: userId,
        data: { po_id: order.id, number: order.number, vendor_id: order.vendor_id, vendor_name: order.vendor_name, value: toRupees(receivedValue), tax: toRupees(receivedTax), complete: after.complete },
      });
      return po(tx, orgId, order.id);
    });
    return { data: { ...result, lines: await poLines(db, result) } };
  });

  // ── overview ──────────────────────────────────────────────────────────────
  async function stats(orgId) {
    return db.one(
      `SELECT
         (SELECT COALESCE(sum(q.quantity * p.cost_price), 0) FROM stock_quants q JOIN products p ON p.id = q.product_id WHERE q.org_id = $1)::numeric(14,2) AS stock_value,
         (SELECT count(*)::int FROM products WHERE org_id = $1 AND active) AS products,
         (SELECT count(*)::int FROM products p WHERE p.org_id = $1 AND p.active AND p.type = 'stockable' AND p.reorder_level > 0
            AND COALESCE((SELECT sum(quantity) FROM stock_quants q WHERE q.org_id = p.org_id AND q.product_id = p.id), 0) <= p.reorder_level) AS low_stock,
         (SELECT count(*)::int FROM purchase_orders WHERE org_id = $1 AND status IN ('draft','approved','partially_received')) AS open_pos,
         (SELECT COALESCE(sum(total), 0) FROM purchase_orders WHERE org_id = $1 AND status IN ('approved','partially_received'))::numeric(14,2) AS incoming_value`,
      [orgId],
    );
  }

  app.get('/erp/overview', { preHandler: guard('erp.inventory.view') }, async (request) => {
    const { orgId } = request.ctx;
    await defaultWarehouse(db, orgId);
    const [summary, low, recent] = await Promise.all([
      stats(orgId),
      db.rows(
        `SELECT p.id, p.name, p.sku, p.uom, p.reorder_level,
                COALESCE((SELECT sum(quantity) FROM stock_quants q WHERE q.org_id = p.org_id AND q.product_id = p.id), 0) AS on_hand
           FROM products p WHERE p.org_id = $1 AND p.active AND p.type = 'stockable' AND p.reorder_level > 0
            AND COALESCE((SELECT sum(quantity) FROM stock_quants q WHERE q.org_id = p.org_id AND q.product_id = p.id), 0) <= p.reorder_level
          ORDER BY p.name LIMIT 10`,
        [orgId],
      ),
      db.rows(
        `SELECT m.id, m.kind, m.quantity, m.reference, m.created_at, p.name AS product_name, p.uom
           FROM stock_moves m JOIN products p ON p.id = m.product_id WHERE m.org_id = $1 ORDER BY m.created_at DESC LIMIT 10`,
        [orgId],
      ),
    ]);
    return { data: { ...summary, low_items: low, recent_moves: recent } };
  });

  app.get('/erp/widgets', { preHandler: guard('erp.inventory.view') }, async (request) => {
    const s = await stats(request.ctx.orgId);
    return { data: { 'erp.stock_value': s.stock_value, 'erp.low_stock': s.low_stock, 'erp.open_pos': s.open_pos } };
  });

  return { products };
}
