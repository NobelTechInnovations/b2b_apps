import { id } from '@nexus/db-kit';
import {
  body, params, validate as v, requireApp, requirePermission, badRequest, resource, nullable,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { nextNumber } from '../lib/numbers.js';
import { moveStock, defaultWarehouse } from '../lib/stock.js';

const qty = { type: 'number', exclusiveMinimum: 0, maximum: 1e6 };

/**
 * Maintenance: the machines, when each is next due for service, and the
 * requests that repair them. Spare parts come out of Inventory when the
 * request is closed, so the stock count knows the belt was used.
 */
export async function maintenanceRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('maintenance'), requirePermission(permission)];

  resource(app, {
    path: '/maintenance/equipment', table: 'equipment', prefix: 'eqp', appSlug: 'maintenance', label: 'Equipment',
    permissions: { view: 'maintenance.equipment.view', manage: 'maintenance.equipment.manage' },
    fields: {
      name: v.text(160, 1), code: nullable(v.text(40, 1)), category: nullable(v.text(80)), location: nullable(v.text(160)),
      serial_number: nullable(v.text(80)), work_center_id: nullable(v.id('wc')), purchase_date: nullable(v.date), warranty_until: nullable(v.date),
      preventive_every_days: nullable(v.int(1, 3650)), last_maintained_on: nullable(v.date),
      status: v.enum(['operational', 'down', 'retired']), technician_id: nullable(v.id('usr')), notes: v.text(5000, 0),
    },
    required: ['name'], search: ['name', 'code', 'serial_number', 'location', 'category'],
    filters: { status: v.enum(['operational', 'down', 'retired']) }, defaultSort: 'name ASC', sorts: ['name', 'created_at'],
    uniqueMessage: 'Another machine uses that code.',
    columns: `t.*, CASE WHEN t.preventive_every_days IS NULL THEN NULL
                        ELSE COALESCE(t.last_maintained_on, t.purchase_date, t.created_at::date) + t.preventive_every_days END AS next_due,
              (SELECT count(*)::int FROM maintenance_requests r WHERE r.org_id = t.org_id AND r.equipment_id = t.id AND r.status IN ('new', 'in_progress')) AS open_requests,
              (SELECT COALESCE(sum(r.downtime_hours), 0) FROM maintenance_requests r WHERE r.org_id = t.org_id AND r.equipment_id = t.id
                 AND r.completed_at >= now() - interval '365 days') AS downtime_year`,
    hooks: {
      async detail(store, row) {
        const history = await store.rows(
          `SELECT id, number, title, kind, status, priority, completed_at, downtime_hours, created_at FROM maintenance_requests
            WHERE org_id = $1 AND equipment_id = $2 ORDER BY created_at DESC LIMIT 25`,
          [row.org_id, row.id],
        );
        return { ...row, history };
      },
    },
  });

  // ── requests ──────────────────────────────────────────────────────────────
  const requests = resource(app, {
    path: '/maintenance/requests', table: 'maintenance_requests', prefix: 'mreq', appSlug: 'maintenance', label: 'Maintenance request',
    permissions: { view: 'maintenance.requests.view', create: 'maintenance.requests.create', edit: 'maintenance.requests.create', delete: 'maintenance.requests.close' },
    fields: {
      equipment_id: v.id('eqp'), title: v.text(200, 1), kind: v.enum(['corrective', 'preventive']), priority: v.enum(['low', 'normal', 'high', 'urgent']),
      assignee_id: nullable(v.id('usr')), scheduled_for: nullable(v.date), description: v.text(10000, 0),
    },
    required: ['equipment_id', 'title'], search: ['number', 'title', 'description'],
    filters: { status: v.enum(['new', 'in_progress', 'repaired', 'scrapped', 'cancelled']), kind: v.enum(['corrective', 'preventive']), equipment_id: v.id('eqp'), assignee_id: v.id('usr') },
    defaultSort: `created_at DESC`,
    columns: 't.*, e.name AS equipment_name, e.code AS equipment_code, e.location AS equipment_location',
    from: 'maintenance_requests t JOIN equipment e ON e.id = t.equipment_id',
    uniqueMessage: 'This machine already has an open preventive request.',
    hooks: {
      async beforeCreate(tx, data, request) {
        const { orgId } = request.ctx;
        const machine = await tx.one(`SELECT * FROM equipment WHERE org_id = $1 AND id = $2`, [orgId, data.equipment_id]);
        if (!machine) throw badRequest('Choose one of this workspace’s machines.');
        if (machine.status === 'retired') throw badRequest(`${machine.name} is retired.`);
        return { ...data, number: await nextNumber(tx, orgId, 'mreq', 'MR') };
      },
      async afterCreate(tx, row, request) {
        tx.emit({
          type: EVENTS.MAINTENANCE_REQUESTED, org_id: row.org_id, actor_id: request.ctx.userId,
          data: { request_id: row.id, number: row.number, title: row.title, equipment_name: row.equipment_name, priority: row.priority, assignee_id: row.assignee_id },
        });
      },
      async beforeUpdate(tx, data, old) {
        if (!['new', 'in_progress'].includes(old.status)) throw badRequest(`This request is ${old.status}.`);
        if (data.equipment_id && data.equipment_id !== old.equipment_id) throw badRequest('A request stays with its machine. Create a new one instead.');
        return data;
      },
    },
  });

  const reqParams = { params: params({ id: v.id('mreq') }) };

  app.post('/maintenance/requests/:id/start', { preHandler: guard('maintenance.requests.create'), schema: { ...reqParams, body: body({ equipment_down: v.bool }) } }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const old = await requests.load(tx, orgId, request.params.id, { lock: true });
      if (old.status !== 'new') throw badRequest(`This request is ${old.status.replace('_', ' ')}.`);
      await tx.query(`UPDATE maintenance_requests SET status = 'in_progress', started_at = now(), assignee_id = COALESCE(assignee_id, $3), updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, old.id, userId]);
      if (request.body?.equipment_down) await tx.query(`UPDATE equipment SET status = 'down', updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, old.equipment_id]);
      return requests.load(tx, orgId, old.id);
    });
    return { data: row };
  });

  app.post('/maintenance/requests/:id/complete', {
    preHandler: guard('maintenance.requests.close'),
    schema: {
      ...reqParams,
      body: body({
        outcome: v.enum(['repaired', 'scrapped']), resolution: v.text(10000, 1), downtime_hours: { type: 'number', minimum: 0, maximum: 10000 },
        parts: { type: 'array', maxItems: 50, items: body({ product_id: v.id('prd'), quantity: qty }, ['product_id', 'quantity']) },
      }, ['resolution']),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const outcome = b.outcome ?? 'repaired';
    const row = await db.transaction(async (tx) => {
      const old = await requests.load(tx, orgId, request.params.id, { lock: true });
      if (!['new', 'in_progress'].includes(old.status)) throw badRequest(`This request is already ${old.status}.`);
      if (!b.resolution.trim()) throw badRequest('Say what was done.');
      const parts = [];
      if (b.parts?.length) {
        const wh = await defaultWarehouse(tx, orgId);
        for (const part of b.parts) {
          const move = await moveStock(tx, {
            orgId, userId, productId: part.product_id, fromWarehouseId: wh.id, quantity: part.quantity,
            kind: 'maintenance', reference: old.number, sourceType: 'maintenance_request', sourceId: old.id,
          });
          const item = await tx.one(`SELECT name, uom FROM products WHERE id = $1`, [part.product_id]);
          parts.push({ product_id: part.product_id, name: item.name, uom: item.uom, quantity: Number(part.quantity), move_id: move.id });
        }
      }
      await tx.query(
        `UPDATE maintenance_requests SET status = $3, resolution = $4, downtime_hours = COALESCE($5, downtime_hours), parts = $6,
                started_at = COALESCE(started_at, now()), completed_at = now(), updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, outcome, b.resolution.trim(), b.downtime_hours ?? null, JSON.stringify(parts)],
      );
      await tx.query(
        `UPDATE equipment SET status = $3, last_maintained_on = CASE WHEN $3 = 'operational' THEN current_date ELSE last_maintained_on END, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, old.equipment_id, outcome === 'scrapped' ? 'retired' : 'operational'],
      );
      return requests.load(tx, orgId, old.id);
    });
    return { data: row };
  });

  app.post('/maintenance/requests/:id/cancel', { preHandler: guard('maintenance.requests.close'), schema: reqParams }, async (request) => {
    const { orgId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const old = await requests.load(tx, orgId, request.params.id, { lock: true });
      if (!['new', 'in_progress'].includes(old.status)) throw badRequest(`This request is already ${old.status}.`);
      await tx.query(`UPDATE maintenance_requests SET status = 'cancelled', updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, old.id]);
      return requests.load(tx, orgId, old.id);
    });
    return { data: row };
  });

  // Preventive work due in the next week, raised once per machine.
  app.post('/maintenance/preventive/generate', {
    preHandler: guard('maintenance.requests.create'),
    schema: { body: body({ within_days: v.int(0, 90) }) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const within = request.body?.within_days ?? 7;
    const created = await db.transaction(async (tx) => {
      const due = await tx.rows(
        `SELECT e.*, COALESCE(e.last_maintained_on, e.purchase_date, e.created_at::date) + e.preventive_every_days AS next_due
           FROM equipment e
          WHERE e.org_id = $1 AND e.status <> 'retired' AND e.preventive_every_days IS NOT NULL
            AND COALESCE(e.last_maintained_on, e.purchase_date, e.created_at::date) + e.preventive_every_days <= current_date + $2::int
            AND NOT EXISTS (SELECT 1 FROM maintenance_requests r WHERE r.org_id = e.org_id AND r.equipment_id = e.id
                             AND r.kind = 'preventive' AND r.status IN ('new', 'in_progress'))`,
        [orgId, within],
      );
      const out = [];
      for (const machine of due) {
        const row = await tx.one(
          `INSERT INTO maintenance_requests (id, org_id, number, equipment_id, title, kind, priority, assignee_id, scheduled_for, created_by)
           VALUES ($1,$2,$3,$4,$5,'preventive','normal',$6,$7,$8) RETURNING *`,
          [id('mreq'), orgId, await nextNumber(tx, orgId, 'mreq', 'MR'), machine.id, `Preventive service: ${machine.name}`,
            machine.technician_id, machine.next_due, userId],
        );
        tx.emit({ type: EVENTS.MAINTENANCE_REQUESTED, org_id: orgId, actor_id: userId, data: { request_id: row.id, number: row.number, title: row.title, equipment_name: machine.name, priority: 'normal', assignee_id: row.assignee_id } });
        out.push(row);
      }
      return out;
    });
    return { data: { created: created.length, requests: created } };
  });

  app.get('/maintenance/overview', { preHandler: guard('maintenance.equipment.view') }, async (request) => {
    const row = await db.one(
      `SELECT (SELECT count(*)::int FROM equipment WHERE org_id = $1 AND status <> 'retired') AS equipment,
              (SELECT count(*)::int FROM equipment WHERE org_id = $1 AND status = 'down') AS down,
              (SELECT count(*)::int FROM maintenance_requests WHERE org_id = $1 AND status IN ('new', 'in_progress')) AS open_requests,
              (SELECT count(*)::int FROM equipment e WHERE e.org_id = $1 AND e.status <> 'retired' AND e.preventive_every_days IS NOT NULL
                  AND COALESCE(e.last_maintained_on, e.purchase_date, e.created_at::date) + e.preventive_every_days <= current_date + 7) AS due_soon,
              (SELECT round(avg(downtime_hours), 1) FROM maintenance_requests WHERE org_id = $1 AND kind = 'corrective'
                  AND completed_at >= now() - interval '90 days') AS mean_downtime_hours`,
      [request.ctx.orgId],
    );
    return { data: row };
  });
}
