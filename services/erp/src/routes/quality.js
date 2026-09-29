import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, resource, nullable,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { nextNumber } from '../lib/numbers.js';

const checklistSchema = { type: 'array', maxItems: 50, items: body({ label: v.text(200, 1) }, ['label']) };

/**
 * Quality: plans say what to inspect and when (on receipt, after
 * production); checks are raised automatically from those moments and
 * performed point by point; a failure becomes a non-conformance report that
 * cannot be closed without a corrective action.
 */
export async function qualityRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('quality'), requirePermission(permission)];

  resource(app, {
    path: '/quality/plans', table: 'quality_plans', prefix: 'qp', appSlug: 'quality', label: 'Inspection plan',
    permissions: { view: 'quality.checks.view', manage: 'quality.plans.manage' },
    fields: {
      name: v.text(160, 1), trigger: v.enum(['receipt', 'production', 'manual']),
      product_id: nullable(v.id('prd')), category_id: nullable(v.id('pcat')), checklist: checklistSchema, active: v.bool,
    },
    required: ['name'], json: ['checklist'], search: ['name'], filters: { trigger: v.enum(['receipt', 'production', 'manual']), active: v.bool },
    defaultSort: 'name ASC',
    columns: 't.*, p.name AS product_name, c.name AS category_name',
    from: 'quality_plans t LEFT JOIN products p ON p.id = t.product_id LEFT JOIN product_categories c ON c.id = t.category_id',
    hooks: {
      async beforeCreate(tx, data, request) {
        await assertScope(tx, request.ctx.orgId, data);
        if (!data.checklist?.length) throw badRequest('Add at least one checkpoint.');
        return data;
      },
      async beforeUpdate(tx, data, old, request) {
        await assertScope(tx, request.ctx.orgId, data);
        if (data.checklist && !data.checklist.length) throw badRequest('Add at least one checkpoint.');
        return data;
      },
    },
  });
  async function assertScope(tx, orgId, data) {
    if (data.product_id && !(await tx.one(`SELECT 1 FROM products WHERE org_id = $1 AND id = $2`, [orgId, data.product_id]))) throw badRequest('Choose one of this workspace’s products.');
    if (data.category_id && !(await tx.one(`SELECT 1 FROM product_categories WHERE org_id = $1 AND id = $2`, [orgId, data.category_id]))) throw badRequest('Choose one of this workspace’s categories.');
  }

  // ── checks ────────────────────────────────────────────────────────────────
  const checkParams = { params: params({ checkId: v.id('qc') }) };
  async function check(store, orgId, checkId, lock = false) {
    const row = await store.one(
      `SELECT c.*, p.name AS product_name, pl.name AS plan_name FROM quality_checks c
         LEFT JOIN products p ON p.id = c.product_id LEFT JOIN quality_plans pl ON pl.id = c.plan_id
        WHERE c.org_id = $1 AND c.id = $2${lock ? ' FOR UPDATE OF c' : ''}`,
      [orgId, checkId],
    );
    if (!row) throw notFound('Quality check');
    return row;
  }

  app.get('/quality/checks', {
    preHandler: guard('quality.checks.view'),
    schema: { querystring: query({ status: v.enum(['pending', 'passed', 'failed']), trigger: v.enum(['receipt', 'production', 'manual']) }) },
  }, async (request) => {
    const values = [request.ctx.orgId];
    const where = ['c.org_id = $1'];
    for (const key of ['status', 'trigger']) {
      if (request.query[key]) { values.push(request.query[key]); where.push(`c.${key} = $${values.length}`); }
    }
    if (request.query.q) { values.push(`%${request.query.q}%`); where.push(`(c.number ILIKE $${values.length} OR p.name ILIKE $${values.length} OR c.source_ref ILIKE $${values.length})`); }
    const rows = await db.rows(
      `SELECT c.*, p.name AS product_name, pl.name AS plan_name FROM quality_checks c
         LEFT JOIN products p ON p.id = c.product_id LEFT JOIN quality_plans pl ON pl.id = c.plan_id
        WHERE ${where.join(' AND ')} ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC LIMIT 200`,
      values,
    );
    return { data: rows };
  });

  app.get('/quality/checks/:checkId', { preHandler: guard('quality.checks.view'), schema: checkParams }, async (request) => {
    const row = await check(db, request.ctx.orgId, request.params.checkId);
    const ncrs = await db.rows(`SELECT id, number, title, status, severity FROM quality_ncrs WHERE org_id = $1 AND check_id = $2`, [row.org_id, row.id]);
    return { data: { ...row, ncrs } };
  });

  app.post('/quality/checks', {
    preHandler: guard('quality.checks.perform'),
    schema: { body: body({ plan_id: v.id('qp'), product_id: v.id('prd'), quantity: { type: 'number', exclusiveMinimum: 0 }, source_ref: v.text(80, 0), checklist: checklistSchema }, ['product_id']) },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      if (!(await tx.one(`SELECT 1 FROM products WHERE org_id = $1 AND id = $2`, [orgId, b.product_id]))) throw badRequest('Choose one of this workspace’s products.');
      let points = b.checklist ?? [];
      if (b.plan_id) {
        const plan = await tx.one(`SELECT * FROM quality_plans WHERE org_id = $1 AND id = $2`, [orgId, b.plan_id]);
        if (!plan) throw badRequest('Choose one of this workspace’s inspection plans.');
        points = plan.checklist;
      }
      if (!points.length) throw badRequest('Choose a plan or list what to check.');
      const created = await tx.one(
        `INSERT INTO quality_checks (id, org_id, number, plan_id, product_id, trigger, source_ref, quantity, results, created_by)
         VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9) RETURNING id`,
        [id('qc'), orgId, await nextNumber(tx, orgId, 'qc', 'QC'), b.plan_id ?? null, b.product_id, b.source_ref || null, b.quantity ?? null,
          JSON.stringify(points.map((p) => ({ label: p.label, passed: null, note: '' }))), userId],
      );
      return check(tx, orgId, created.id);
    });
    return reply.status(201).send({ data: row });
  });

  app.post('/quality/checks/:checkId/perform', {
    preHandler: guard('quality.checks.perform'),
    schema: {
      ...checkParams,
      body: body({
        results: { type: 'array', minItems: 1, maxItems: 50, items: body({ label: v.text(200, 1), passed: v.bool, note: v.text(500, 0) }, ['label', 'passed']) },
        note: v.text(2000, 0), raise_ncr: v.bool,
      }, ['results']),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const old = await check(tx, orgId, request.params.checkId, true);
      if (old.status !== 'pending') throw badRequest('This check has already been recorded.');
      const expected = old.results.map((r) => r.label);
      const given = new Map(b.results.map((r) => [r.label, r]));
      if (expected.some((label) => !given.has(label))) throw badRequest('Record a result for every checkpoint.');
      const results = expected.map((label) => ({ label, passed: given.get(label).passed, note: given.get(label).note ?? '' }));
      const failed = results.filter((r) => !r.passed);
      const status = failed.length ? 'failed' : 'passed';
      await tx.query(
        `UPDATE quality_checks SET status = $3, results = $4, note = $5, performed_by = $6, performed_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2`,
        [orgId, old.id, status, JSON.stringify(results), b.note ?? '', userId],
      );
      if (failed.length) {
        tx.emit({ type: EVENTS.QUALITY_CHECK_FAILED, org_id: orgId, actor_id: userId, data: { check_id: old.id, number: old.number, product_name: old.product_name, failed: failed.map((f) => f.label) } });
        if (b.raise_ncr !== false) {
          await raiseNcr(tx, {
            orgId, userId, checkId: old.id, productId: old.product_id,
            title: `${old.product_name ?? 'Product'} failed ${old.number}`,
            description: failed.map((f) => `• ${f.label}${f.note ? ` — ${f.note}` : ''}`).join('\n'),
            severity: 'major',
          });
        }
      }
      return check(tx, orgId, old.id);
    });
    return { data: row };
  });

  async function raiseNcr(tx, { orgId, userId, checkId = null, productId = null, title, description = '', severity = 'minor', ownerId = null, dueDate = null }) {
    const ncr = await tx.one(
      `INSERT INTO quality_ncrs (id, org_id, number, title, check_id, product_id, severity, description, owner_id, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id('ncr'), orgId, await nextNumber(tx, orgId, 'ncr', 'NCR'), title, checkId, productId, severity, description, ownerId, dueDate, userId],
    );
    tx.emit({ type: EVENTS.NCR_RAISED, org_id: orgId, actor_id: userId, data: { ncr_id: ncr.id, number: ncr.number, title: ncr.title, severity: ncr.severity, owner_id: ncr.owner_id } });
    return ncr;
  }

  // ── non-conformance reports ───────────────────────────────────────────────
  resource(app, {
    path: '/quality/ncr', table: 'quality_ncrs', prefix: 'ncr', appSlug: 'quality', label: 'Non-conformance report',
    permissions: { view: 'quality.ncr.view', create: 'quality.ncr.create', edit: 'quality.ncr.create', delete: 'quality.ncr.close' },
    fields: {
      title: v.text(200, 1), check_id: nullable(v.id('qc')), product_id: nullable(v.id('prd')), severity: v.enum(['minor', 'major', 'critical']),
      description: v.text(10000, 0), root_cause: v.text(10000, 0), corrective_action: v.text(10000, 0),
      status: v.enum(['open', 'investigating', 'resolved', 'closed']), owner_id: nullable(v.id('usr')), due_date: nullable(v.date),
    },
    required: ['title'], search: ['number', 'title', 'description'],
    filters: { status: v.enum(['open', 'investigating', 'resolved', 'closed']), severity: v.enum(['minor', 'major', 'critical']) },
    defaultSort: "created_at DESC",
    columns: 't.*, p.name AS product_name, c.number AS check_number',
    from: 'quality_ncrs t LEFT JOIN products p ON p.id = t.product_id LEFT JOIN quality_checks c ON c.id = t.check_id',
    hooks: {
      async beforeCreate(tx, data, request) {
        const { orgId, userId } = request.ctx;
        if (data.status === 'closed') throw badRequest('A report starts open.');
        return { ...data, number: await nextNumber(tx, orgId, 'ncr', 'NCR'), created_by: userId };
      },
      async afterCreate(tx, row, request) {
        tx.emit({ type: EVENTS.NCR_RAISED, org_id: row.org_id, actor_id: request.ctx.userId, data: { ncr_id: row.id, number: row.number, title: row.title, severity: row.severity, owner_id: row.owner_id } });
      },
      async beforeUpdate(tx, data, old, request) {
        if (old.status === 'closed' && data.status !== 'open') throw badRequest('This report is closed. Reopen it to change it.');
        if (data.status === 'closed' && old.status !== 'closed') {
          request.ctx.assert('quality.ncr.close');
          const action = (data.corrective_action ?? old.corrective_action ?? '').trim();
          if (!action) throw badRequest('Record the corrective action before closing the report.');
          return { ...data, closed_by: request.ctx.userId, closed_at: new Date().toISOString() };
        }
        if (data.status && data.status !== 'closed' && old.status === 'closed') return { ...data, closed_by: null, closed_at: null };
        return data;
      },
    },
  });

  app.get('/quality/overview', { preHandler: guard('quality.checks.view') }, async (request) => {
    const row = await db.one(
      `SELECT (SELECT count(*)::int FROM quality_checks WHERE org_id = $1 AND status = 'pending') AS pending,
              (SELECT count(*)::int FROM quality_checks WHERE org_id = $1 AND status = 'failed' AND performed_at >= now() - interval '30 days') AS failed_30d,
              (SELECT round(100.0 * count(*) FILTER (WHERE status = 'passed') / NULLIF(count(*), 0))::int FROM quality_checks
                WHERE org_id = $1 AND status <> 'pending' AND performed_at >= now() - interval '30 days') AS pass_rate,
              (SELECT count(*)::int FROM quality_ncrs WHERE org_id = $1 AND status <> 'closed') AS open_ncrs`,
      [request.ctx.orgId],
    );
    return { data: row };
  });
}
