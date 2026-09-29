import { id } from '@nexus/db-kit';
import { appBySlug } from '@nexus/contracts';
import { EVENTS } from '@nexus/contracts/events';
import { quote, prorate, periodEnd } from './pricing.js';
import { recomputeEntitlements } from './entitlements.js';

/**
 * Platform invoices: what a workspace owes Nexus. Every term is invoiced
 * before it starts ("advance payment") and access for that term depends on it
 * being paid.
 *
 *   subscription  the first term, due when the trial ends (or immediately)
 *   renewal       the next term, raised a week before the current one ends
 *   adjustment    a prorated charge for seats or apps added mid-term
 */

/** India's financial year starts in April. */
function fiscalYear(date = new Date()) {
  const year = date.getUTCMonth() >= 3 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

/** Gap-free: the counter row is locked inside the caller's transaction. */
async function nextNumber(tx) {
  const fy = fiscalYear();
  const row = await tx.one(
    `INSERT INTO invoice_counters (fiscal_year, last_value) VALUES ($1, 1)
     ON CONFLICT (fiscal_year) DO UPDATE SET last_value = invoice_counters.last_value + 1
     RETURNING last_value`,
    [fy],
  );
  return `NX/${fy}/${String(row.last_value).padStart(6, '0')}`;
}

/** The non-core apps currently on a subscription, in the order they were added. */
export async function subscribedApps(store, subscriptionId) {
  const rows = await store.rows(
    `SELECT app_slug FROM subscription_items
      WHERE subscription_id = $1 AND removed_at IS NULL ORDER BY added_at, app_slug`,
    [subscriptionId],
  );
  return rows
    .map((r) => r.app_slug)
    .filter((slug) => slug !== 'core')
    .map((slug) => ({ slug, name: appBySlug(slug)?.name ?? slug }));
}

export async function planFor(store, slug) {
  return store.one(`SELECT * FROM plans WHERE slug = $1`, [slug]);
}

/** Price the subscription as it stands, for one full term of its cycle. */
export async function priceSubscription(store, subscription, overrides = {}) {
  const plan = overrides.plan ?? (await planFor(store, subscription.plan_slug));
  const apps = overrides.apps ?? (await subscribedApps(store, subscription.id));
  return quote({
    plan,
    apps,
    seats: overrides.seats ?? subscription.seats,
    cycle: overrides.cycle ?? subscription.billing_cycle,
  });
}

async function insertInvoice(tx, { subscription, kind, priced, periodStart, periodEndAt, dueAt, lines, apps }) {
  const number = await nextNumber(tx);
  const invoice = await tx.one(
    `INSERT INTO invoices
       (id, org_id, subscription_id, number, status, currency, subtotal, tax_amount, total,
        period_start, period_end, due_at, lines, kind, billing_cycle, seats, app_slugs)
     VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      id('binv'), subscription.org_id, subscription.id, number, subscription.currency ?? 'INR',
      priced.subtotal, priced.tax_amount, priced.total, periodStart, periodEndAt, dueAt,
      JSON.stringify(lines ?? priced.lines), kind, subscription.billing_cycle, subscription.seats,
      (apps ?? []).map((a) => a.slug ?? a),
    ],
  );
  tx.emit({
    type: EVENTS.INVOICE_ISSUED,
    org_id: subscription.org_id,
    data: { invoice_id: invoice.id, number, kind, total: invoice.total, due_at: dueAt },
  });
  return invoice;
}

/**
 * The invoice for the NEXT unpaid term: the first term of a new subscription,
 * or the renewal of a paid one. Any open one is voided and re-issued, so the
 * amount always matches the subscription as it is now.
 */
export async function issueTermInvoice(tx, subscription) {
  await tx.query(
    `UPDATE invoices SET status = 'void', voided_at = now(), updated_at = now()
      WHERE subscription_id = $1 AND status = 'open' AND kind IN ('subscription', 'renewal')`,
    [subscription.id],
  );
  if (subscription.status === 'canceled') return null;

  const priced = await priceSubscription(tx, subscription);
  const apps = await subscribedApps(tx, subscription.id);
  const paid = subscription.status === 'active' || Boolean(await tx.one(
    `SELECT 1 FROM invoices WHERE subscription_id = $1 AND status = 'paid' AND kind IN ('subscription','renewal') LIMIT 1`,
    [subscription.id],
  ));

  let start;
  let kind;
  if (paid) {
    // Renewal: the next term begins where the paid one ends.
    if (subscription.cancel_at_period_end) return null;
    start = new Date(subscription.current_period_end);
    kind = 'renewal';
  } else {
    // First term: it starts when the trial ends, or now if there is none left.
    const trialEnd = subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null;
    start = trialEnd && trialEnd > new Date() ? trialEnd : new Date();
    kind = 'subscription';
  }

  return insertInvoice(tx, {
    subscription,
    kind,
    priced,
    periodStart: start,
    periodEndAt: periodEnd(start, subscription.billing_cycle),
    dueAt: start,
    apps,
  });
}

/**
 * A mid-term increase on a PAID term: seats or apps added now are usable now,
 * and the prorated difference is invoiced, due within a few days.
 */
export async function issueAdjustment(tx, subscription, { before, after, reason }) {
  if (subscription.status !== 'active') return null;
  const charge = prorate({
    before,
    after,
    periodStart: subscription.current_period_start,
    periodEnd: subscription.current_period_end,
  });
  if (!charge) return null;

  const dueAt = new Date(Date.now() + 3 * 86_400_000);
  const lines = [{
    kind: 'adjustment',
    slug: 'proration',
    label: reason,
    detail: `Prorated for the ${charge.days_remaining} day(s) left in this term`,
    quantity: 1,
    unit_price: charge.subtotal,
    amount: charge.subtotal,
  }];
  return insertInvoice(tx, {
    subscription,
    kind: 'adjustment',
    priced: charge,
    periodStart: new Date(),
    periodEndAt: subscription.current_period_end,
    dueAt,
    lines,
    apps: [],
  });
}

/**
 * Record a captured payment and apply what it pays for. Idempotent: settling a
 * paid invoice again is a no-op, which is what lets the browser callback and
 * the provider's webhook both arrive safely.
 */
export async function settleInvoice(tx, { invoiceId, provider, providerPaymentId, providerOrderId, amount, actorId }) {
  const invoice = await tx.one(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  if (!invoice) throw new Error(`invoice ${invoiceId} not found`);
  if (invoice.status === 'paid') return { invoice, alreadyPaid: true };
  if (invoice.status !== 'open') throw new Error(`invoice ${invoice.number} is ${invoice.status}`);

  const expected = Math.round(Number(invoice.total) * 100);
  const received = Math.round(Number(amount) * 100);
  if (received !== expected) {
    throw new Error(`payment of ${amount} does not match invoice total ${invoice.total}`);
  }

  const existing = providerOrderId
    ? await tx.one(`SELECT id FROM payments WHERE provider = $1 AND provider_order_id = $2`, [provider, providerOrderId])
    : null;
  if (existing) {
    await tx.query(
      `UPDATE payments SET status = 'captured', provider_payment_id = $2, captured_at = now() WHERE id = $1`,
      [existing.id, providerPaymentId],
    );
  } else {
    await tx.query(
      `INSERT INTO payments (id, org_id, invoice_id, provider, provider_order_id, provider_payment_id,
                             amount, currency, status, created_by, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'captured',$9, now())`,
      [id('pay'), invoice.org_id, invoice.id, provider, providerOrderId ?? null, providerPaymentId ?? null,
        invoice.total, invoice.currency, actorId ?? null],
    );
  }

  const paid = await tx.one(
    `UPDATE invoices SET status = 'paid', amount_paid = total, paid_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [invoice.id],
  );

  const subscription = await tx.one(`SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE`, [invoice.subscription_id]);
  if (subscription && subscription.status !== 'canceled') {
    if (invoice.kind === 'subscription' || invoice.kind === 'renewal') {
      await tx.query(
        `UPDATE subscriptions SET status = 'active', current_period_start = $2, current_period_end = $3
          WHERE id = $1`,
        [subscription.id, invoice.period_start, invoice.period_end],
      );
    } else if (subscription.status === 'past_due') {
      // An overdue adjustment was the only thing wrong: back to good standing.
      const stillOverdue = await tx.one(
        `SELECT 1 FROM invoices WHERE subscription_id = $1 AND status = 'open' AND due_at < now() LIMIT 1`,
        [subscription.id],
      );
      const termPaid = new Date(subscription.current_period_end) > new Date();
      if (!stillOverdue && termPaid) {
        await tx.query(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [subscription.id]);
      }
    }
    await recomputeEntitlements(tx, subscription.org_id, { actorId });
  }

  tx.emit({
    type: EVENTS.INVOICE_PAID,
    org_id: invoice.org_id,
    actor_id: actorId,
    data: { invoice_id: invoice.id, number: invoice.number, total: invoice.total, provider, kind: invoice.kind },
  });

  return { invoice: paid, alreadyPaid: false };
}

export function shapeInvoice(i) {
  return {
    id: i.id,
    number: i.number,
    kind: i.kind,
    status: i.status,
    currency: i.currency,
    subtotal: i.subtotal,
    tax_amount: i.tax_amount,
    total: i.total,
    amount_paid: i.amount_paid,
    period_start: i.period_start,
    period_end: i.period_end,
    due_at: i.due_at,
    paid_at: i.paid_at,
    seats: i.seats,
    billing_cycle: i.billing_cycle,
    lines: i.lines,
    created_at: i.created_at,
  };
}
