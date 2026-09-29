import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, resource, nullable, amount,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { moveStock, warehouseOrDefault, product as loadProduct, onHand } from '../lib/stock.js';
import { nextNumber } from '../lib/numbers.js';
import { toPaise, toRupees } from '../lib/money.js';
import { createChecks } from '../lib/quality.js';

const qty = { anyOf: [{ type: 'number', exclusiveMinimum: 0, maximum: 1e9 }, { type: 'string', pattern: '^\\d+(\\.\\d{1,3})?$' }] };
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Manufacturing: a bill of materials says what one batch needs; a
 * manufacturing order makes N of something. Completing an order consumes the
 * components and puts the finished goods on the shelf in one transaction —
 * through the same stock ledger as everything else.
 */
export async function manufacturingRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('manufacturing'), requirePermission(permission)];

  // ── work centers ──────────────────────────────────────────────────────────
  resource(app, {
    path: '/manufacturing/work-centers', table: 'work_centers', prefix: 'wc', appSlug: 'manufacturing', label: 'Work center',
    permissions: { view: 'manufacturing.workcenters.view', manage: 'manufacturing.workcenters.manage' },
    fields: {
      name: v.text(120, 1), code: nullable(v.text(20, 1)), hours_per_day: { type: 'number', exclusiveMinimum: 0, maximum: 24 },
      cost_per_hour: amount, active: v.bool, notes: v.text(2000, 0),
    },
    required: ['name'], search: ['name', 'code'], defaultSort: 'name ASC',
    uniqueMessage: 'A work center with that name already exists.',
    columns: `t.*, (SELECT count(*)::int FROM manufacturing_orders mo WHERE mo.org_id = t.org_id AND mo.work_center_id = t.id
                      AND mo.status IN ('confirmed', 'in_progress')) AS active_orders`,
  });

  // ── bills of materials ────────────────────────────────────────────────────
  const bomParams = { params: params({ bomId: v.id('bom') }) };
  const bomBody = {
    product_id: v.id('prd'), name: v.text(160, 0), quantity: qty, work_center_id: nullable(v.id('wc')),
    hours: { type: 'number', minimum: 0, maximum: 10000 }, notes: v.text(2000, 0), active: v.bool,
    lines: { type: 'array', minItems: 1, maxItems: 200, items: body({ product_id: v.id('prd'), quantity: qty }, ['product_id', 'quantity']) },
  };

  async function bom(store, orgId, bomId) {
    const row = await store.one(
      `SELECT b.*, p.name AS product_name, p.uom, w.name AS work_center_name FROM boms b
         JOIN products p ON p.id = b.product_id LEFT JOIN work_centers w ON w.id = b.work_center_id
        WHERE b.org_id = $1 AND b.id = $2`,
      [orgId, bomId],
    );
    if (!row) throw notFound('Bill of materials');
    return row;
  }
  const bomLines = (store, row) => store.rows(
    `SELECT l.*, p.name AS product_name, p.sku, p.uom, p.cost_price, p.type AS product_type FROM bom_lines l JOIN products p ON p.id = l.product_id
      WHERE l.org_id = $1 AND l.bom_id = $2 ORDER BY l.position`,
    [row.org_id, row.id],
  );
  const withCost = (row, lines) => {
    const cost = lines.reduce((sum, l) => sum + Math.round(toPaise(l.cost_price) * Number(l.quantity)), 0);
    return { ...row, lines, component_cost: toRupees(cost), unit_cost: toRupees(cost / Number(row.quantity)) };
  };

  async function writeBomLines(tx, orgId, row, lines) {
    await tx.query(`DELETE FROM bom_lines WHERE org_id = $1 AND bom_id = $2`, [orgId, row.id]);
    const seen = new Set();
    for (const [index, line] of lines.entries()) {
      if (line.product_id === row.product_id) throw badRequest('A product cannot be a component of itself.');
      if (seen.has(line.product_id)) throw badRequest('Each component should appear once; combine the quantities.');
      seen.add(line.product_id);
      const item = await loadProduct(tx, orgId, line.product_id);
      if (item.type === 'service') throw badRequest(`${item.name} is a service and cannot be a component.`);
      await tx.query(
        `INSERT INTO bom_lines (id, org_id, bom_id, position, product_id, quantity) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id('boml'), orgId, row.id, index, item.id, Number(line.quantity)],
      );
    }
  }

  app.get('/manufacturing/boms', {
    preHandler: guard('manufacturing.bom.view'),
    schema: { querystring: query({ product_id: v.id('prd'), active: v.bool }) },
  }, async (request) => {
    const values = [request.ctx.orgId];
    const where = ['b.org_id = $1'];
    if (request.query.product_id) { values.push(request.query.product_id); where.push(`b.product_id = $${values.length}`); }
    if (request.query.active !== undefined) { values.push(request.query.active); where.push(`b.active = $${values.length}`); }
    if (request.query.q) { values.push(`%${request.query.q}%`); where.push(`(p.name ILIKE $${values.length} OR b.name ILIKE $${values.length})`); }
    const rows = await db.rows(
      `SELECT b.*, p.name AS product_name, p.uom, w.name AS work_center_name,
              (SELECT count(*)::int FROM bom_lines l WHERE l.org_id = b.org_id AND l.bom_id = b.id) AS component_count,
              (SELECT COALESCE(sum(l.quantity * c.cost_price), 0) FROM bom_lines l JOIN products c ON c.id = l.product_id
                WHERE l.org_id = b.org_id AND l.bom_id = b.id)::numeric(14,2) AS component_cost
         FROM boms b JOIN products p ON p.id = b.product_id LEFT JOIN work_centers w ON w.id = b.work_center_id
        WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 200`,
      values,
    );
    return { data: rows };
  });

  app.get('/manufacturing/boms/:bomId', { preHandler: guard('manufacturing.bom.view'), schema: bomParams }, async (request) => {
    const row = await bom(db, request.ctx.orgId, request.params.bomId);
    return { data: withCost(row, await bomLines(db, row)) };
  });

  app.post('/manufacturing/boms', {
    preHandler: guard('manufacturing.bom.manage'),
    schema: { body: body(bomBody, ['product_id', 'lines']) },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const item = await loadProduct(tx, orgId, b.product_id);
      if (item.type === 'service') throw badRequest('Services are not manufactured.');
      if (b.work_center_id) await assertWorkCenter(tx, orgId, b.work_center_id);
      const created = await tx.one(
        `INSERT INTO boms (id, org_id, product_id, name, quantity, work_center_id, hours, notes, active, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5, 1),$6,COALESCE($7, 0),$8,COALESCE($9, true),$10) RETURNING *`,
        [id('bom'), orgId, item.id, b.name || `${item.name} recipe`, b.quantity ?? null, b.work_center_id ?? null, b.hours ?? null, b.notes ?? '', b.active ?? null, userId],
      );
      await writeBomLines(tx, orgId, created, b.lines);
      return bom(tx, orgId, created.id);
    });
    return reply.status(201).send({ data: withCost(row, await bomLines(db, row)) });
  });

  app.patch('/manufacturing/boms/:bomId', {
    preHandler: guard('manufacturing.bom.manage'),
    schema: { ...bomParams, body: body(bomBody) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const old = await bom(tx, orgId, request.params.bomId);
      if (b.product_id && b.product_id !== old.product_id) throw badRequest('A recipe belongs to one product. Create a new one instead.');
      if (b.work_center_id) await assertWorkCenter(tx, orgId, b.work_center_id);
      const next = { ...old, ...b };
      await tx.query(
        `UPDATE boms SET name = $3, quantity = $4, work_center_id = $5, hours = $6, notes = $7, active = $8, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, next.name, Number(next.quantity), next.work_center_id, next.hours, next.notes, next.active],
      );
      if (b.lines) await writeBomLines(tx, orgId, old, b.lines);
      return bom(tx, orgId, old.id);
    });
    return { data: withCost(row, await bomLines(db, row)) };
  });

  app.delete('/manufacturing/boms/:bomId', { preHandler: guard('manufacturing.bom.manage'), schema: bomParams }, async (request) => {
    const { orgId } = request.ctx;
    const used = await db.one(`SELECT 1 FROM manufacturing_orders WHERE org_id = $1 AND bom_id = $2 LIMIT 1`, [orgId, request.params.bomId]);
    if (used) throw badRequest('Orders were made with this recipe. Archive it (untick Active) instead.');
    const row = await db.one(`DELETE FROM boms WHERE org_id = $1 AND id = $2 RETURNING id`, [orgId, request.params.bomId]);
    if (!row) throw notFound('Bill of materials');
    return { data: { deleted: true } };
  });

  async function assertWorkCenter(tx, orgId, workCenterId) {
    const row = await tx.one(`SELECT 1 FROM work_centers WHERE org_id = $1 AND id = $2`, [orgId, workCenterId]);
    if (!row) throw badRequest('Choose one of this workspace’s work centers.');
  }

  // ── manufacturing orders ──────────────────────────────────────────────────
  const moParams = { params: params({ moId: v.id('mo') }) };

  async function mo(store, orgId, moId, lock = false) {
    const row = await store.one(
      `SELECT mo.*, p.name AS product_name, p.uom, w.name AS work_center_name, wh.name AS warehouse_name, b.quantity AS bom_quantity, b.hours AS bom_hours
         FROM manufacturing_orders mo JOIN products p ON p.id = mo.product_id JOIN boms b ON b.id = mo.bom_id
         LEFT JOIN work_centers w ON w.id = mo.work_center_id LEFT JOIN warehouses wh ON wh.id = mo.warehouse_id
        WHERE mo.org_id = $1 AND mo.id = $2${lock ? ' FOR UPDATE OF mo' : ''}`,
      [orgId, moId],
    );
    if (!row) throw notFound('Manufacturing order');
    return row;
  }

  /** What an order needs, and whether it is on the shelf right now. */
  async function requirements(store, order) {
    const lines = await store.rows(
      `SELECT l.product_id, l.quantity, p.name AS product_name, p.uom, p.type, p.cost_price FROM bom_lines l JOIN products p ON p.id = l.product_id
        WHERE l.org_id = $1 AND l.bom_id = $2 ORDER BY l.position`,
      [order.org_id, order.bom_id],
    );
    const factor = Number(order.quantity) / Number(order.bom_quantity);
    const out = [];
    for (const line of lines) {
      const required = round3(Number(line.quantity) * factor);
      const available = line.type === 'stockable' ? await onHand(store, order.org_id, line.product_id, order.warehouse_id) : null;
      out.push({ ...line, required, available, short: available !== null && available < required });
    }
    return out;
  }

  app.get('/manufacturing/orders', {
    preHandler: guard('manufacturing.orders.view'),
    schema: { querystring: query({ status: v.enum(['draft', 'confirmed', 'in_progress', 'done', 'cancelled', 'open']), work_center_id: v.id('wc'), from: v.date, to: v.date }) },
  }, async (request) => {
    const qs = request.query;
    const values = [request.ctx.orgId];
    const where = ['mo.org_id = $1'];
    if (qs.status === 'open') where.push(`mo.status IN ('draft', 'confirmed', 'in_progress')`);
    else if (qs.status) { values.push(qs.status); where.push(`mo.status = $${values.length}`); }
    if (qs.work_center_id) { values.push(qs.work_center_id); where.push(`mo.work_center_id = $${values.length}`); }
    if (qs.from) { values.push(qs.from); where.push(`COALESCE(mo.planned_end, mo.planned_start) >= $${values.length}::date`); }
    if (qs.to) { values.push(qs.to); where.push(`mo.planned_start <= $${values.length}::date`); }
    if (qs.q) { values.push(`%${qs.q}%`); where.push(`(mo.number ILIKE $${values.length} OR p.name ILIKE $${values.length})`); }
    const rows = await db.rows(
      `SELECT mo.*, p.name AS product_name, p.uom, w.name AS work_center_name,
              (b.hours * mo.quantity / b.quantity)::numeric(10,2) AS planned_hours
         FROM manufacturing_orders mo JOIN products p ON p.id = mo.product_id JOIN boms b ON b.id = mo.bom_id
         LEFT JOIN work_centers w ON w.id = mo.work_center_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE mo.status WHEN 'in_progress' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, mo.planned_start NULLS LAST, mo.created_at DESC
        LIMIT 200`,
      values,
    );
    return { data: rows };
  });

  app.get('/manufacturing/orders/:moId', { preHandler: guard('manufacturing.orders.view'), schema: moParams }, async (request) => {
    const row = await mo(db, request.ctx.orgId, request.params.moId);
    return { data: { ...row, components: await requirements(db, row) } };
  });

  app.post('/manufacturing/orders', {
    preHandler: guard('manufacturing.orders.create'),
    schema: {
      body: body({
        product_id: v.id('prd'), bom_id: v.id('bom'), quantity: qty, work_center_id: nullable(v.id('wc')),
        warehouse_id: nullable(v.id('wh')), planned_start: nullable(v.date), planned_end: nullable(v.date), notes: v.text(2000, 0),
      }, ['product_id', 'quantity']),
    },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    if (b.planned_start && b.planned_end && b.planned_end < b.planned_start) throw badRequest('The end date is before the start date.');
    const row = await db.transaction(async (tx) => {
      const recipe = b.bom_id
        ? await tx.one(`SELECT * FROM boms WHERE org_id = $1 AND id = $2 AND product_id = $3`, [orgId, b.bom_id, b.product_id])
        : await tx.one(`SELECT * FROM boms WHERE org_id = $1 AND product_id = $2 AND active ORDER BY created_at DESC LIMIT 1`, [orgId, b.product_id]);
      if (!recipe) throw badRequest('This product has no bill of materials yet. Create one first.');
      const wh = await warehouseOrDefault(tx, orgId, b.warehouse_id);
      const created = await tx.one(
        `INSERT INTO manufacturing_orders (id, org_id, number, product_id, bom_id, quantity, work_center_id, warehouse_id, planned_start, planned_end, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [id('mo'), orgId, await nextNumber(tx, orgId, 'mo', 'MO'), b.product_id, recipe.id, Number(b.quantity),
          b.work_center_id ?? recipe.work_center_id, wh.id, b.planned_start ?? null, b.planned_end ?? null, b.notes ?? '', userId],
      );
      return mo(tx, orgId, created.id);
    });
    return reply.status(201).send({ data: { ...row, components: await requirements(db, row) } });
  });

  app.patch('/manufacturing/orders/:moId', {
    preHandler: guard('manufacturing.orders.edit'),
    schema: {
      ...moParams,
      body: body({ quantity: qty, work_center_id: nullable(v.id('wc')), planned_start: nullable(v.date), planned_end: nullable(v.date), notes: v.text(2000, 0) }),
    },
  }, async (request) => {
    const { orgId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const old = await mo(tx, orgId, request.params.moId, true);
      if (['done', 'cancelled'].includes(old.status)) throw badRequest(`This order is ${old.status}.`);
      if (b.quantity !== undefined && old.status !== 'draft') throw badRequest('The quantity can only change while the order is a draft.');
      if (b.work_center_id) await assertWorkCenter(tx, orgId, b.work_center_id);
      const next = { ...old, ...b };
      if (next.planned_start && next.planned_end && next.planned_end < next.planned_start) throw badRequest('The end date is before the start date.');
      await tx.query(
        `UPDATE manufacturing_orders SET quantity = $3, work_center_id = $4, planned_start = $5, planned_end = $6, notes = $7, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, Number(next.quantity), next.work_center_id, next.planned_start, next.planned_end, next.notes],
      );
      return mo(tx, orgId, old.id);
    });
    return { data: { ...row, components: await requirements(db, row) } };
  });

  const transition = (path, from, to, extra = '') => app.post(`/manufacturing/orders/:moId/${path}`, {
    preHandler: guard('manufacturing.orders.edit'), schema: moParams,
  }, async (request) => {
    const { orgId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const old = await mo(tx, orgId, request.params.moId, true);
      if (!from.includes(old.status)) throw badRequest(`This order is ${old.status.replace('_', ' ')}.`);
      await tx.query(`UPDATE manufacturing_orders SET status = $3${extra}, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, old.id, to]);
      return mo(tx, orgId, old.id);
    });
    return { data: { ...row, components: await requirements(db, row) } };
  });
  transition('confirm', ['draft'], 'confirmed');
  transition('start', ['confirmed'], 'in_progress', ', started_at = now()');
  transition('cancel', ['draft', 'confirmed', 'in_progress'], 'cancelled');

  // Finishing: consume what the batch used (including what was scrapped),
  // put the good units on the shelf, and cost them from their components.
  app.post('/manufacturing/orders/:moId/complete', {
    preHandler: guard('manufacturing.orders.edit'),
    schema: { ...moParams, body: body({ produced_quantity: qty, scrap_quantity: { type: 'number', minimum: 0 } }) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const order = await mo(tx, orgId, request.params.moId, true);
      if (!['confirmed', 'in_progress'].includes(order.status)) throw badRequest(order.status === 'draft' ? 'Confirm the order first.' : `This order is ${order.status}.`);
      const produced = Number(request.body?.produced_quantity ?? order.quantity);
      const scrap = Number(request.body?.scrap_quantity ?? 0);
      if (produced + scrap > Number(order.quantity) * 1.5) throw badRequest('That is far more than the order was for. Check the quantities.');
      const factor = (produced + scrap) / Number(order.bom_quantity);
      const lines = await tx.rows(
        `SELECT l.product_id, l.quantity, p.type, p.cost_price FROM bom_lines l JOIN products p ON p.id = l.product_id WHERE l.org_id = $1 AND l.bom_id = $2`,
        [orgId, order.bom_id],
      );
      let cost = 0;
      for (const line of lines) {
        const use = round3(Number(line.quantity) * factor);
        if (!(use > 0)) continue;
        cost += Math.round(toPaise(line.cost_price) * use);
        await moveStock(tx, {
          orgId, userId, productId: line.product_id, fromWarehouseId: order.warehouse_id, quantity: use,
          kind: 'production_out', reference: order.number, sourceType: 'manufacturing_order', sourceId: order.id,
        });
      }
      const unitCost = produced > 0 ? toRupees(cost / produced) : null;
      if (produced > 0) {
        await moveStock(tx, {
          orgId, userId, productId: order.product_id, toWarehouseId: order.warehouse_id, quantity: produced,
          kind: 'production_in', reference: order.number, sourceType: 'manufacturing_order', sourceId: order.id, unitCost,
        });
      }
      await tx.query(
        `UPDATE manufacturing_orders SET status = 'done', produced_quantity = $3, scrap_quantity = $4, unit_cost = $5,
                started_at = COALESCE(started_at, now()), finished_at = now(), updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, order.id, produced, scrap, unitCost],
      );
      if (produced > 0) {
        await createChecks(tx, { orgId, userId, trigger: 'production', items: [{ product_id: order.product_id, quantity: produced }], sourceType: 'manufacturing_order', sourceId: order.id, sourceRef: order.number });
      }
      tx.emit({
        type: EVENTS.MO_COMPLETED, org_id: orgId, actor_id: userId,
        data: { mo_id: order.id, number: order.number, product_id: order.product_id, product_name: order.product_name, produced, scrap, value: toRupees(cost) },
      });
      return mo(tx, orgId, order.id);
    });
    return { data: { ...row, components: await requirements(db, row) } };
  });

  // Capacity: planned hours per work center per day against what it can do.
  app.get('/manufacturing/planning', {
    preHandler: guard('manufacturing.orders.view'),
    schema: { querystring: query({ from: v.date, to: v.date }) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const from = request.query.from ?? new Date().toISOString().slice(0, 10);
    const to = request.query.to ?? new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
    const [centers, orders] = await Promise.all([
      db.rows(`SELECT id, name, hours_per_day FROM work_centers WHERE org_id = $1 AND active ORDER BY name`, [orgId]),
      db.rows(
        `SELECT mo.id, mo.number, mo.status, mo.work_center_id, mo.quantity, p.name AS product_name,
                COALESCE(mo.planned_start, current_date) AS start_on, COALESCE(mo.planned_end, mo.planned_start, current_date) AS end_on,
                (b.hours * mo.quantity / b.quantity)::float AS hours
           FROM manufacturing_orders mo JOIN products p ON p.id = mo.product_id JOIN boms b ON b.id = mo.bom_id
          WHERE mo.org_id = $1 AND mo.status IN ('draft', 'confirmed', 'in_progress')
            AND COALESCE(mo.planned_end, mo.planned_start, current_date) >= $2::date AND COALESCE(mo.planned_start, current_date) <= $3::date
          ORDER BY start_on`,
        [orgId, from, to],
      ),
    ]);
    const days = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) days.push(d.toISOString().slice(0, 10));
    const load = centers.map((c) => {
      const perDay = Object.fromEntries(days.map((day) => [day, 0]));
      for (const o of orders.filter((x) => x.work_center_id === c.id)) {
        const s = new Date(o.start_on).toISOString().slice(0, 10);
        const e = new Date(o.end_on).toISOString().slice(0, 10);
        const span = days.filter((day) => day >= s && day <= e);
        const spread = span.length ? o.hours / Math.max(1, Math.round((new Date(e) - new Date(s)) / 86_400_000) + 1) : 0;
        for (const day of span) perDay[day] += spread;
      }
      return { ...c, days: days.map((day) => ({ day, hours: Math.round(perDay[day] * 10) / 10, capacity: Number(c.hours_per_day) })) };
    });
    return { data: { from, to, days, work_centers: load, orders } };
  });

  app.get('/manufacturing/widgets', { preHandler: guard('manufacturing.orders.view') }, async (request) => {
    const row = await db.one(`SELECT count(*)::int AS n FROM manufacturing_orders WHERE org_id = $1 AND status IN ('confirmed', 'in_progress')`, [request.ctx.orgId]);
    return { data: { 'mfg.in_production': row.n } };
  });
}
