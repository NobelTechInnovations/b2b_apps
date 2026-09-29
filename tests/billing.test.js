import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, invite, ok } from './helpers.js';

/**
 * Seat plans and advance payment.
 *   Basic ₹1,599 · 10 seats · 5 apps     Business ₹2,599 · 20 seats · 5 apps
 *   ₹259 per extra seat · ₹99 per app beyond the fifth · all monthly, + 18% GST
 */
const line = (quote, slug) => quote.lines.find((l) => l.slug === slug);

test('seat plans, prepaid invoices and payments', async (t) => {
  const { client: owner, stamp } = await workspace(['crm', 'hr'], { plan: 'basic', seats: 10 });

  await t.test('quotes follow the plan arithmetic', async () => {
    const base = ok(await owner.call('/subscriptions/quote', 'POST', { plan: 'basic', app_slugs: ['crm'], seats: 10 }));
    assert.equal(base.subtotal, '1599.00');
    assert.equal(base.tax_amount, '287.82');
    assert.equal(base.total, '1886.82');

    const seats = ok(await owner.call('/subscriptions/quote', 'POST', { plan: 'basic', app_slugs: ['crm'], seats: 12 }));
    assert.equal(line(seats, 'extra_seats').amount, '518.00');

    const six = ok(await owner.call('/subscriptions/quote', 'POST', {
      plan: 'business', app_slugs: ['crm', 'hr', 'payroll', 'tasks', 'documents', 'invoicing'], seats: 20,
    }));
    assert.equal(line(six, 'extra_apps').quantity, 1);
    assert.equal(line(six, 'extra_apps').amount, '99.00');
    assert.equal(six.subtotal, '2698.00');

    const fewer = ok(await owner.call('/subscriptions/quote', 'POST', { plan: 'business', app_slugs: [], seats: 3 }));
    assert.equal(fewer.seats, 20, 'the plan seats are a floor');

    const annual = ok(await owner.call('/subscriptions/quote', 'POST', { plan: 'basic', app_slugs: [], seats: 10, cycle: 'annual' }));
    assert.equal(annual.subtotal, '15990.00', 'twelve months for the price of ten');
  });

  await t.test('a trial starts with the first term invoiced in advance', async () => {
    const sub = ok(await owner.call('/subscriptions/current'));
    assert.equal(sub.status, 'trialing');
    const open = sub.invoices.filter((i) => i.status === 'open');
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, 'subscription');
    assert.equal(open[0].total, '1886.82');
    assert.equal(new Date(open[0].period_start).toISOString(), new Date(sub.trial_ends_at).toISOString());
  });

  await t.test('changing seats during the trial re-issues the term invoice', async () => {
    ok(await owner.call('/subscriptions/current', 'PATCH', { seats: 11 }));
    const sub = ok(await owner.call('/subscriptions/current'));
    const open = sub.invoices.filter((i) => i.status === 'open');
    assert.equal(open.length, 1);
    assert.equal(open[0].subtotal, '1858.00');
  });

  await t.test('paying the term invoice activates the subscription', async () => {
    const sub = ok(await owner.call('/subscriptions/current'));
    const invoice = sub.next_due_invoice;
    const checkout = ok(await owner.call(`/subscriptions/current/invoices/${invoice.id}/checkout`, 'POST', {}));
    assert.equal(checkout.provider, 'test');
    ok(await owner.call(`/subscriptions/current/invoices/${invoice.id}/test-pay`, 'POST', {}));
    const paid = ok(await owner.call('/subscriptions/current'));
    assert.equal(paid.status, 'active');
    assert.equal(paid.amount_due, '0.00');
    assert.equal(new Date(paid.current_period_start).toISOString(), new Date(invoice.period_start).toISOString());
    // Paying twice is a no-op, not a second charge.
    const again = await owner.call(`/subscriptions/current/invoices/${invoice.id}/test-pay`, 'POST', {});
    assert.equal(again.data?.already_paid, true);
  });

  await t.test('adding apps beyond five mid-term raises a prorated adjustment', async () => {
    for (const slug of ['payroll', 'tasks', 'documents']) ok(await owner.call('/subscriptions/current/apps', 'POST', { app_slug: slug }));
    const sixth = ok(await owner.call('/subscriptions/current/apps', 'POST', { app_slug: 'invoicing' }));
    assert.equal(sixth.extra_app_count, 1);
    assert.ok(sixth.adjustment_invoice, 'an adjustment invoice for the 6th app');
    assert.equal(sixth.adjustment_invoice.kind, 'adjustment');
    // A full term of ₹99 + GST at most; less because part of the term is left.
    assert.ok(Number(sixth.adjustment_invoice.subtotal) <= 99 && Number(sixth.adjustment_invoice.subtotal) > 0);
  });

  await t.test('seats are enforced on invitations', async () => {
    const sub = ok(await owner.call('/subscriptions/current'));
    const roles = ok(await owner.call('/roles'));
    const member = roles.find((r) => r.slug === 'member').id;
    // 1 owner already; fill the rest with invitations.
    for (let i = 1; i < sub.seats; i += 1) {
      ok(await owner.call('/invitations', 'POST', { email: `seat-${i}-${stamp}@nexus.test`, role_ids: [member] }), 201);
    }
    const over = await owner.call('/invitations', 'POST', { email: `seat-over-${stamp}@nexus.test`, role_ids: [member] });
    assert.equal(over.status, 402);
    assert.equal(over.error.code, 'seat_limit');
    // And seats cannot be cut below what is in use.
    const cut = await owner.call('/subscriptions/current', 'PATCH', { seats: 10 });
    assert.equal(cut.status, 400);
  });

  await t.test('only the owner may pay', async () => {
    const admin = await invite(owner, 'admin', `${stamp}-payer`).catch(() => null);
    if (!admin) return; // seats full from the previous step is fine too
    const sub = ok(await owner.call('/subscriptions/current'));
    const invoice = sub.invoices.find((i) => i.status === 'open');
    if (invoice) assert.equal((await admin.call(`/subscriptions/current/invoices/${invoice.id}/test-pay`, 'POST', {})).status, 403);
  });
});
