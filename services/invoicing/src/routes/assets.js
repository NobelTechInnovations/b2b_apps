import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, resource, nullable, amount,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { postEntry, nextFinanceNumber } from '../lib/ledger.js';
import { toPaise, toRupees } from '../lib/money.js';

const monthOf = (value) => `${String(value).slice(0, 7)}-01`;
const addMonths = (month, n) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * One month's depreciation for an asset, given what has been taken so far.
 * Straight line spreads (cost − salvage) evenly over the life; written-down
 * value takes rate/12 of what is left. Neither goes below salvage.
 */
export function monthlyDepreciation(asset, accumulatedPaise) {
  const cost = toPaise(asset.cost);
  const floor = toPaise(asset.salvage_value);
  const room = cost - floor - accumulatedPaise;
  if (room <= 0) return 0;
  const raw = asset.method === 'wdv'
    ? Math.round(((cost - accumulatedPaise) * Number(asset.wdv_rate)) / 1200)
    : Math.round((cost - floor) / Number(asset.useful_life_months));
  return Math.min(raw, room);
}

/** The whole schedule from purchase to salvage (capped at 50 years). */
export function schedule(asset) {
  const out = [];
  let accumulated = 0;
  let month = monthOf(asset.purchase_date);
  for (let i = 0; i < 600; i += 1) {
    const amountPaise = monthlyDepreciation(asset, accumulated);
    if (amountPaise <= 0) break;
    accumulated += amountPaise;
    out.push({ period: month, amount: toRupees(amountPaise), accumulated: toRupees(accumulated), book_value: toRupees(toPaise(asset.cost) - accumulated) });
    month = addMonths(month, 1);
  }
  return out;
}

const PAID_FROM = { bank: 'bank', cash: 'cash', payable: 'ap', capital: 'capital' };

/** The last day of a month, or today if that day has not come yet. */
function endOfMonthOrToday(month) {
  const last = new Date(new Date(`${addMonths(month, 1)}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return last > today ? today : last;
}

/**
 * Asset Management: the fixed asset register, monthly depreciation posted to
 * the ledger, and disposals that book the gain or loss.
 */
export async function assetRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('assets'), requirePermission(permission)];

  const assets = resource(app, {
    path: '/assets/register', table: 'fixed_assets', prefix: 'fa', appSlug: 'assets', label: 'Asset',
    permissions: { view: 'assets.register.view', manage: 'assets.register.manage' },
    fields: {
      name: v.text(160, 1), category: nullable(v.text(80)), purchase_date: v.date, cost: amount, salvage_value: amount,
      method: v.enum(['slm', 'wdv']), useful_life_months: nullable(v.int(1, 1200)), wdv_rate: nullable({ type: 'number', exclusiveMinimum: 0, maximum: 100 }),
      location: nullable(v.text(160)), custodian: nullable(v.text(120)), serial_number: nullable(v.text(80)), notes: v.text(5000, 0),
      paid_from: v.enum(['bank', 'cash', 'payable', 'capital', 'none']),
    },
    required: ['name', 'purchase_date', 'cost'],
    search: ['number', 'name', 'category', 'serial_number', 'custodian'],
    filters: { status: v.enum(['active', 'disposed']), category: v.text(80) },
    defaultSort: 'purchase_date DESC',
    columns: `t.*, (t.cost - t.accumulated_depreciation)::numeric(14,2) AS book_value`,
    hooks: {
      async beforeCreate(tx, data, request) {
        const { paid_from: _paidFrom, ...rest } = data;
        validate(rest);
        return { ...rest, number: await nextFinanceNumber(tx, request.ctx.orgId, 'asset', 'FA') };
      },
      // Buying the asset is posted with it, when the form says how it was paid.
      async afterCreate(tx, asset, request) {
        const paidFrom = request.body.paid_from;
        if (!paidFrom || paidFrom === 'none') return;
        await postEntry(tx, {
          orgId: asset.org_id, userId: request.ctx.userId, date: asset.purchase_date, memo: `Asset ${asset.number} · ${asset.name}`,
          source: 'asset', sourceRef: `buy:${asset.id}`,
          lines: [{ key: 'fixed_assets', debit: asset.cost }, { key: PAID_FROM[paidFrom], credit: asset.cost }],
        });
      },
      async beforeUpdate(tx, data, old) {
        const { paid_from: _ignored, ...rest } = data;
        if (old.status === 'disposed') throw badRequest('This asset has been disposed of.');
        const depreciated = toPaise(old.accumulated_depreciation) > 0;
        if (depreciated && ['cost', 'purchase_date', 'method', 'useful_life_months', 'wdv_rate', 'salvage_value'].some((k) => k in rest)) {
          throw badRequest('Depreciation has been posted for this asset, so its cost, date and method are fixed.');
        }
        validate({ ...old, ...rest });
        return rest;
      },
      async beforeDelete(tx, old) {
        if (toPaise(old.accumulated_depreciation) > 0) throw badRequest('Depreciation has been posted for this asset. Dispose of it instead.');
      },
      async detail(store, row) {
        const posted = await store.rows(`SELECT period, amount FROM asset_depreciation WHERE org_id = $1 AND asset_id = $2 ORDER BY period`, [row.org_id, row.id]);
        return { ...row, posted, schedule: schedule(row).slice(0, 120) };
      },
    },
  });

  function validate(a) {
    if (toPaise(a.salvage_value ?? 0) >= toPaise(a.cost)) throw badRequest('Salvage value must be less than the cost.');
    if ((a.method ?? 'slm') === 'slm' && !a.useful_life_months) throw badRequest('Give the useful life in months for straight-line depreciation.');
    if (a.method === 'wdv' && !a.wdv_rate) throw badRequest('Give the annual rate for written-down-value depreciation.');
    if (a.purchase_date && a.purchase_date > new Date().toISOString().slice(0, 10)) throw badRequest('The purchase date is in the future.');
  }

  app.post('/assets/register/:id/capitalise', {
    preHandler: [...guard('assets.register.manage'), requirePermission('accounting.journal.post')],
    schema: { params: params({ id: v.id('fa') }), body: body({ paid_from: v.enum(['bank', 'cash', 'payable', 'capital']) }, ['paid_from']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const entry = await db.transaction(async (tx) => {
      const asset = await assets.load(tx, orgId, request.params.id, { lock: true });
      return postEntry(tx, {
        orgId, userId, date: asset.purchase_date, memo: `Asset ${asset.number} · ${asset.name}`, source: 'asset', sourceRef: `buy:${asset.id}`,
        lines: [{ key: 'fixed_assets', debit: asset.cost }, { key: PAID_FROM[request.body.paid_from], credit: asset.cost }],
      });
    });
    return { data: entry };
  });

  // Run depreciation up to a month. Any month an asset missed is caught up;
  // a month already run for an asset is never run again.
  app.post('/assets/depreciation/run', {
    preHandler: guard('assets.depreciation.run'),
    schema: { body: body({ period: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } }, ['period']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const period = `${request.body.period}-01`;
    if (period > monthOf(new Date().toISOString())) throw badRequest('Depreciation cannot be run for a future month.');
    const result = await db.transaction(async (tx) => {
      const list = await tx.rows(
        `SELECT * FROM fixed_assets WHERE org_id = $1 AND status = 'active' AND purchase_date < ($2::date + interval '1 month') FOR UPDATE`,
        [orgId, period],
      );
      let total = 0;
      const rows = [];
      for (const asset of list) {
        let accumulated = toPaise(asset.accumulated_depreciation);
        let month = asset.last_depreciated_period ? addMonths(String(asset.last_depreciated_period).slice(0, 10), 1) : monthOf(asset.purchase_date);
        let assetTotal = 0;
        while (month <= period) {
          const amountPaise = monthlyDepreciation(asset, accumulated);
          if (amountPaise <= 0) break;
          const inserted = await tx.one(
            `INSERT INTO asset_depreciation (id, org_id, asset_id, period, amount, created_by) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (asset_id, period) DO NOTHING RETURNING id`,
            [id('dep'), orgId, asset.id, month, toRupees(amountPaise), userId],
          );
          if (inserted) { accumulated += amountPaise; assetTotal += amountPaise; rows.push(inserted.id); }
          month = addMonths(month, 1);
        }
        if (assetTotal > 0) {
          await tx.query(
            `UPDATE fixed_assets SET accumulated_depreciation = $3, last_depreciated_period = $4, updated_at = now() WHERE org_id = $1 AND id = $2`,
            [orgId, asset.id, toRupees(accumulated), addMonths(month, -1)],
          );
          total += assetTotal;
        }
      }
      if (!total) return { posted: '0.00', assets: 0, entry: null };
      const entry = await postEntry(tx, {
        orgId, userId, date: endOfMonthOrToday(period),
        memo: `Depreciation to ${request.body.period}`, source: 'depreciation',
        lines: [{ key: 'depreciation', debit: toRupees(total) }, { key: 'accumulated_depreciation', credit: toRupees(total) }],
      });
      await tx.query(`UPDATE asset_depreciation SET journal_entry_id = $2 WHERE id = ANY($1)`, [rows, entry.id]);
      tx.emit({ type: EVENTS.ASSET_DEPRECIATED, org_id: orgId, actor_id: userId, data: { period: request.body.period, amount: toRupees(total), entry_id: entry.id } });
      return { posted: toRupees(total), assets: new Set(rows).size, entry };
    });
    return { data: result };
  });

  app.get('/assets/depreciation', { preHandler: guard('assets.reports.view'), schema: { querystring: query({ year: v.int(2000, 2100) }) } }, async (request) => {
    const { orgId } = request.ctx;
    const year = request.query.year ?? new Date().getFullYear();
    const rows = await db.rows(
      `SELECT to_char(period, 'YYYY-MM') AS period, count(*)::int AS assets, sum(amount)::numeric(14,2) AS amount
         FROM asset_depreciation WHERE org_id = $1 AND extract(year FROM period) = $2 GROUP BY 1 ORDER BY 1`,
      [orgId, year],
    );
    const totals = await db.one(
      `SELECT COALESCE(sum(cost), 0)::numeric(14,2) AS cost, COALESCE(sum(accumulated_depreciation), 0)::numeric(14,2) AS accumulated,
              COALESCE(sum(cost - accumulated_depreciation), 0)::numeric(14,2) AS book_value, count(*)::int AS assets
         FROM fixed_assets WHERE org_id = $1 AND status = 'active'`,
      [orgId],
    );
    return { data: { year, months: rows, totals } };
  });

  app.post('/assets/register/:id/dispose', {
    preHandler: guard('assets.register.manage'),
    schema: { params: params({ id: v.id('fa') }), body: body({ disposed_on: v.date, amount, received_in: v.enum(['bank', 'cash']) }, ['disposed_on']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const b = request.body;
    const row = await db.transaction(async (tx) => {
      const asset = await assets.load(tx, orgId, request.params.id, { lock: true });
      if (asset.status === 'disposed') throw badRequest('This asset was already disposed of.');
      if (b.disposed_on < String(asset.purchase_date).slice(0, 10)) throw badRequest('It cannot be disposed of before it was bought.');
      const received = toPaise(b.amount ?? 0);
      const cost = toPaise(asset.cost);
      const accumulated = toPaise(asset.accumulated_depreciation);
      const result = received - (cost - accumulated);
      await postEntry(tx, {
        orgId, userId, date: b.disposed_on, memo: `Disposal of ${asset.number} · ${asset.name}`, source: 'asset', sourceRef: `dispose:${asset.id}`,
        lines: [
          { key: b.received_in ?? 'bank', debit: toRupees(received) },
          { key: 'accumulated_depreciation', debit: toRupees(accumulated) },
          { key: 'disposal_loss', debit: toRupees(Math.max(-result, 0)) },
          { key: 'fixed_assets', credit: toRupees(cost) },
          { key: 'other_income', credit: toRupees(Math.max(result, 0)) },
        ],
      });
      await tx.query(
        `UPDATE fixed_assets SET status = 'disposed', disposed_on = $3, disposal_amount = $4, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [orgId, asset.id, b.disposed_on, toRupees(received)],
      );
      return { ...(await assets.load(tx, orgId, asset.id)), gain_or_loss: toRupees(result) };
    });
    return { data: row };
  });
}
