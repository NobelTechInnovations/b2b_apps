import {
  body, params, validate as v, requireApp, requirePermission, badRequest, resource, nullable, amount,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { createInvoice } from '../lib/invoice-writer.js';
import { nextFinanceNumber } from '../lib/ledger.js';
import { toPaise, toRupees } from '../lib/money.js';

const MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date, n) => new Date(new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (date, n) => {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  // 31 January + 1 month is 28/29 February, not 3 March.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};
const monthly = (sub) => Math.round((toPaise(sub.price_override ?? sub.plan_amount) * Number(sub.quantity)) / MONTHS[sub.plan_interval]);

/**
 * Recurring Billing: plans, subscriptions and the invoices they raise on
 * each renewal — through the same invoice writer as everything else, so
 * each period is billed once however many times the run is triggered.
 */
export async function recurringRoutes(app) {
  const { db, settings, bus } = app;
  const guard = (permission) => [app.loadContext, requireApp('recurring'), requirePermission(permission)];

  resource(app, {
    path: '/recurring/plans', table: 'recurring_plans', prefix: 'plan', appSlug: 'recurring', label: 'Plan',
    permissions: { view: 'recurring.plans.view', manage: 'recurring.plans.manage' },
    fields: {
      name: v.text(120, 1), description: v.text(1000, 0), amount, interval: v.enum(Object.keys(MONTHS)),
      trial_days: v.int(0, 365), tax_rate: { type: 'number', minimum: 0, maximum: 100 }, hsn_sac: nullable(v.text(12)), active: v.bool,
    },
    required: ['name', 'amount'], search: ['name'], filters: { active: v.bool }, defaultSort: 'amount ASC',
    uniqueMessage: 'A plan with that name already exists.',
    columns: `t.*, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = t.id AND s.status IN ('trialing','active','past_due')) AS subscribers`,
    hooks: {
      async beforeDelete(tx, old) {
        if (await tx.one(`SELECT 1 FROM subscriptions WHERE plan_id = $1 LIMIT 1`, [old.id])) throw badRequest('Customers are on this plan. Archive it instead.');
      },
    },
  });

  const SUB_COLUMNS = `t.*, p.name AS plan_name, p.amount AS plan_amount, p.interval AS plan_interval, np.name AS next_plan_name,
    (SELECT count(*)::int FROM subscription_invoices si WHERE si.subscription_id = t.id) AS invoices_raised`;
  const subs = resource(app, {
    path: '/recurring/subscriptions', table: 'subscriptions', prefix: 'sub', appSlug: 'recurring', label: 'Subscription',
    permissions: { view: 'recurring.customers.view', manage: 'recurring.customers.manage' },
    fields: {
      customer_id: nullable(v.id('cmp')), customer_name: v.text(200, 1), customer_email: nullable(v.email), customer_gstin: nullable(v.text(15)),
      plan_id: v.id('plan'), quantity: v.int(1, 100000), price_override: nullable(amount), start_date: v.date, auto_issue: v.bool, notes: v.text(2000, 0),
    },
    required: ['plan_id'], search: ['number', 'customer_name', 'customer_email'],
    filters: { status: v.enum(['trialing', 'active', 'past_due', 'paused', 'cancelled']), plan_id: v.id('plan') },
    defaultSort: 'created_at DESC',
    columns: SUB_COLUMNS,
    from: 'subscriptions t JOIN recurring_plans p ON p.id = t.plan_id LEFT JOIN recurring_plans np ON np.id = t.next_plan_id',
    shape: (row) => ({ ...row, mrr: toRupees(monthly(row)) }),
    hooks: {
      async beforeCreate(tx, data, request) {
        const { orgId } = request.ctx;
        const plan = await tx.one(`SELECT * FROM recurring_plans WHERE org_id = $1 AND id = $2`, [orgId, data.plan_id]);
        if (!plan || !plan.active) throw badRequest('Choose an active plan.');
        let customer = null;
        if (data.customer_id) {
          customer = await tx.one(`SELECT * FROM customers WHERE org_id = $1 AND id = $2`, [orgId, data.customer_id]);
          if (!customer) throw badRequest('Choose one of this workspace’s customers.');
        }
        const name = data.customer_name?.trim() || customer?.name;
        if (!name) throw badRequest('Name the customer.');
        const start = data.start_date ?? today();
        const trialEnds = plan.trial_days ? addDays(start, plan.trial_days) : null;
        return {
          ...data, customer_name: name, customer_email: data.customer_email ?? customer?.email ?? null, customer_gstin: data.customer_gstin ?? customer?.gstin ?? null,
          start_date: start, trial_ends_on: trialEnds, next_billing_date: trialEnds ?? start, status: trialEnds ? 'trialing' : 'active',
          number: await nextFinanceNumber(tx, orgId, 'subscription', 'SUB'),
        };
      },
      async afterCreate(tx, row, request) {
        tx.emit({ type: EVENTS.SUBSCRIPTION_STARTED, org_id: row.org_id, actor_id: request.ctx.userId, data: { subscription_id: row.id, number: row.number, customer_name: row.customer_name, plan_name: row.plan_name } });
      },
      async beforeUpdate(tx, data, old) {
        if (old.status === 'cancelled') throw badRequest('This subscription is cancelled.');
        if (data.plan_id && data.plan_id !== old.plan_id) throw badRequest('Use “Change plan” — it takes effect at the next renewal.');
        if (data.start_date && data.start_date !== String(old.start_date).slice(0, 10)) throw badRequest('The start date cannot change once a subscription exists.');
        return data;
      },
      async beforeDelete(tx, old) {
        if (await tx.one(`SELECT 1 FROM subscription_invoices WHERE subscription_id = $1 LIMIT 1`, [old.id])) throw badRequest('This subscription has invoices. Cancel it instead.');
      },
      async detail(store, row) {
        const invoices = await store.rows(
          `SELECT si.period_start, si.period_end, i.id, i.number, i.status, i.total, i.amount_due FROM subscription_invoices si JOIN invoices i ON i.id = si.invoice_id
            WHERE si.subscription_id = $1 ORDER BY si.period_start DESC`,
          [row.id],
        );
        return { ...row, invoices };
      },
    },
  });

  const subParams = { params: params({ id: v.id('sub') }) };
  const transition = (path, schema, apply) => app.post(`/recurring/subscriptions/:id/${path}`, {
    preHandler: guard('recurring.customers.manage'), schema: { ...subParams, ...(schema ? { body: schema } : {}) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const sub = await subs.load(tx, orgId, request.params.id, { lock: true });
      await apply(tx, sub, request.body ?? {}, userId);
      return subs.load(tx, orgId, sub.id);
    });
    return { data: { ...row, mrr: toRupees(monthly(row)) } };
  });

  transition('pause', null, async (tx, sub) => {
    if (!['active', 'past_due', 'trialing'].includes(sub.status)) throw badRequest(`This subscription is ${sub.status}.`);
    await tx.query(`UPDATE subscriptions SET status = 'paused', updated_at = now() WHERE id = $1`, [sub.id]);
  });
  transition('resume', null, async (tx, sub) => {
    if (sub.status !== 'paused') throw badRequest('Only a paused subscription can resume.');
    // A paused period is not billed; the next bill is today at the earliest.
    const next = String(sub.next_billing_date).slice(0, 10) < today() ? today() : String(sub.next_billing_date).slice(0, 10);
    await tx.query(`UPDATE subscriptions SET status = 'active', next_billing_date = $2, updated_at = now() WHERE id = $1`, [sub.id, next]);
  });
  transition('cancel', body({ at_period_end: v.bool, reason: v.text(500, 0) }), async (tx, sub, b, userId) => {
    if (sub.status === 'cancelled') throw badRequest('Already cancelled.');
    if (b.at_period_end && sub.status !== 'paused') {
      await tx.query(`UPDATE subscriptions SET cancel_at_period_end = true, cancel_reason = $2, updated_at = now() WHERE id = $1`, [sub.id, b.reason || null]);
      return;
    }
    await tx.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, next_billing_date = NULL, updated_at = now() WHERE id = $1`, [sub.id, b.reason || null]);
    tx.emit({ type: EVENTS.SUBSCRIPTION_CANCELLED, org_id: sub.org_id, actor_id: userId, data: { subscription_id: sub.id, number: sub.number, customer_name: sub.customer_name, reason: b.reason || null } });
  });
  transition('change-plan', body({ plan_id: v.id('plan') }, ['plan_id']), async (tx, sub, b) => {
    if (sub.status === 'cancelled') throw badRequest('This subscription is cancelled.');
    const plan = await tx.one(`SELECT * FROM recurring_plans WHERE org_id = $1 AND id = $2 AND active`, [sub.org_id, b.plan_id]);
    if (!plan) throw badRequest('Choose an active plan.');
    await tx.query(`UPDATE subscriptions SET next_plan_id = $2, updated_at = now() WHERE id = $1`, [sub.id, plan.id === sub.plan_id ? null : plan.id]);
  });

  /**
   * Bill one subscription for the period starting on its next billing date.
   * The invoice is keyed by (subscription, period), so running twice bills once.
   */
  async function billOne(tx, subId, actor = null) {
    const sub = await tx.one(
      `SELECT s.*, p.name AS plan_name, p.amount AS plan_amount, p.interval AS plan_interval, p.tax_rate, p.hsn_sac
         FROM subscriptions s JOIN recurring_plans p ON p.id = s.plan_id WHERE s.id = $1 FOR UPDATE OF s`,
      [subId],
    );
    if (!sub || !['trialing', 'active', 'past_due'].includes(sub.status) || !sub.next_billing_date) return null;
    const periodStart = String(sub.next_billing_date).slice(0, 10);
    if (periodStart > today()) return null;

    if (sub.cancel_at_period_end) {
      await tx.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), next_billing_date = NULL, updated_at = now() WHERE id = $1`, [sub.id]);
      tx.emit({ type: EVENTS.SUBSCRIPTION_CANCELLED, org_id: sub.org_id, actor_id: actor, data: { subscription_id: sub.id, number: sub.number, customer_name: sub.customer_name, reason: sub.cancel_reason } });
      return { cancelled: sub.id };
    }
    let plan = { id: sub.plan_id, name: sub.plan_name, amount: sub.plan_amount, interval: sub.plan_interval, tax_rate: sub.tax_rate, hsn_sac: sub.hsn_sac };
    if (sub.next_plan_id) {
      const next = await tx.one(`SELECT * FROM recurring_plans WHERE id = $1`, [sub.next_plan_id]);
      if (next) plan = next;
    }
    const periodEnd = addDays(addMonths(periodStart, MONTHS[plan.interval]), -1);
    const invoice = await createInvoice(tx, {
      settings, orgId: sub.org_id, userId: actor, issue: sub.auto_issue,
      customer: { id: sub.customer_id, name: sub.customer_name, gstin: sub.customer_gstin },
      source: 'recurring', sourceRef: `${sub.id}:${periodStart}`, reference: sub.number,
      notes: `${plan.name} · ${periodStart} to ${periodEnd}`,
      lines: [{
        description: `${plan.name} (${periodStart} – ${periodEnd})`, hsn_sac: plan.hsn_sac, quantity: sub.quantity,
        unit_price: sub.price_override ?? plan.amount, tax_rate: Number(plan.tax_rate),
      }],
    });
    await tx.query(
      `INSERT INTO subscription_invoices (subscription_id, period_start, period_end, org_id, invoice_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [sub.id, periodStart, periodEnd, sub.org_id, invoice.id],
    );
    await tx.query(
      `UPDATE subscriptions SET next_billing_date = $2, plan_id = $3, next_plan_id = NULL,
              status = CASE WHEN status = 'trialing' THEN 'active' ELSE status END, updated_at = now() WHERE id = $1`,
      [sub.id, addDays(periodEnd, 1), plan.id],
    );
    return { invoice_id: invoice.id, number: invoice.number, total: invoice.total };
  }

  async function runDue({ orgId = null, actor = null } = {}) {
    const due = await db.rows(
      `SELECT id FROM subscriptions WHERE ($1::text IS NULL OR org_id = $1) AND status IN ('trialing', 'active', 'past_due')
          AND next_billing_date <= current_date ORDER BY next_billing_date LIMIT 500`,
      [orgId],
    );
    const results = [];
    for (const row of due) {
      // A customer can be several periods behind (a paused month, a quiet
      // server); bill each missed period, oldest first, up to a year.
      for (let i = 0; i < 12; i += 1) {
        const result = await db.transaction((tx) => billOne(tx, row.id, actor));
        if (!result) break;
        results.push(result);
        if (result.cancelled) break;
      }
    }
    return results;
  }

  app.post('/recurring/run', { preHandler: guard('recurring.customers.manage') }, async (request) => {
    const results = await runDue({ orgId: request.ctx.orgId, actor: request.ctx.userId });
    return { data: { invoices: results.filter((r) => r.invoice_id).length, cancelled: results.filter((r) => r.cancelled).length, results } };
  });

  // Renewals happen on their own: every ten minutes, for every workspace.
  const timer = setInterval(() => { runDue().catch((error) => app.log.error({ err: error }, 'recurring billing run failed')); }, 10 * 60_000);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));

  // ── dunning: an overdue renewal marks the subscription past due; paying
  // it (and anything else overdue) puts it back in good standing.
  if (bus) {
    const subscriptionOf = async (invoiceId) => {
      const row = await db.one(`SELECT org_id, source, source_ref FROM invoices WHERE id = $1`, [invoiceId]);
      return row?.source === 'recurring' && row.source_ref ? row.source_ref.split(':')[0] : null;
    };
    bus.subscribe('recurring', EVENTS.INVOICE_OVERDUE, async (event) => {
      const subId = await subscriptionOf(event.data?.invoice_id);
      if (subId) await db.query(`UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE id = $1 AND status IN ('active', 'trialing')`, [subId]);
    });
    bus.subscribe('recurring', EVENTS.INVOICE_PAID, async (event) => {
      const subId = await subscriptionOf(event.data?.invoice_id);
      if (!subId) return;
      await db.query(
        `UPDATE subscriptions s SET status = 'active', updated_at = now() WHERE s.id = $1 AND s.status = 'past_due'
            AND NOT EXISTS (SELECT 1 FROM subscription_invoices si JOIN invoices i ON i.id = si.invoice_id
                             WHERE si.subscription_id = s.id AND i.status = 'overdue')`,
        [subId],
      );
    });
  }

  // ── revenue metrics ───────────────────────────────────────────────────────
  async function metrics(orgId) {
    const rows = await db.rows(
      `SELECT s.*, p.name AS plan_name, p.amount AS plan_amount, p.interval AS plan_interval FROM subscriptions s JOIN recurring_plans p ON p.id = s.plan_id WHERE s.org_id = $1`,
      [orgId],
    );
    const live = rows.filter((r) => ['active', 'past_due'].includes(r.status));
    const mrr = live.reduce((s, r) => s + monthly(r), 0);
    const monthStart = `${today().slice(0, 7)}-01`;
    const since = addDays(today(), -30);
    const churned = rows.filter((r) => r.status === 'cancelled' && r.cancelled_at && new Date(r.cancelled_at).toISOString().slice(0, 10) >= since);
    const newThisMonth = live.filter((r) => String(r.start_date).slice(0, 10) >= monthStart);
    const byPlan = {};
    for (const r of live) {
      byPlan[r.plan_name] ??= { plan: r.plan_name, subscribers: 0, mrr: 0 };
      byPlan[r.plan_name].subscribers += 1;
      byPlan[r.plan_name].mrr += monthly(r);
    }
    return {
      mrr: toRupees(mrr), arr: toRupees(mrr * 12), active: live.length, past_due: rows.filter((r) => r.status === 'past_due').length,
      trialing: rows.filter((r) => r.status === 'trialing').length, paused: rows.filter((r) => r.status === 'paused').length,
      new_mrr: toRupees(newThisMonth.reduce((s, r) => s + monthly(r), 0)), churned_mrr: toRupees(churned.reduce((s, r) => s + monthly(r), 0)),
      churn_rate: live.length + churned.length ? Math.round((1000 * churned.length) / (live.length + churned.length)) / 10 : 0,
      by_plan: Object.values(byPlan).map((p) => ({ ...p, mrr: toRupees(p.mrr) })).sort((a, b) => Number(b.mrr) - Number(a.mrr)),
    };
  }

  app.get('/recurring/revenue', { preHandler: guard('recurring.reports.view') }, async (request) => ({ data: await metrics(request.ctx.orgId) }));
  app.get('/recurring/widgets', { preHandler: guard('recurring.customers.view') }, async (request) => ({ data: { 'recurring.mrr': (await metrics(request.ctx.orgId)).mrr } }));
}
