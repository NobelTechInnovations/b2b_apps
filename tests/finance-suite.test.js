import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, invite, ok } from './helpers.js';

const APPS = ['invoicing', 'accounting', 'assets', 'recurring', 'erp', 'pos'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Postings arrive through the event bus; wait for the one we expect. */
async function entryFor(client, source, predicate = () => true, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const rows = ok(await client.call(`/accounting/journal?source=${source}&limit=50`));
    const hit = rows.find(predicate);
    if (hit) return ok(await client.call(`/accounting/journal/${hit.id}`));
    await sleep(500);
  }
  throw new Error(`no ${source} journal entry arrived within ${timeout} ms`);
}
const line = (entry, name) => entry.lines.find((l) => l.account_name === name);

test('Accounting: postings from sales, payments, purchases and the till; statements that balance', async (t) => {
  const { client: owner, stamp } = await workspace(APPS);
  const member = await invite(owner, 'member', `${stamp}-clerk`);
  let invoice;

  await t.test('an issued invoice posts receivable, sales and GST', async () => {
    const draft = ok(await owner.call('/invoicing/invoices', 'POST', { customer_name: 'Mehta Traders', lines: [{ description: 'Consulting', quantity: 2, unit_price: '5000', tax_rate: 18 }] }), 201);
    invoice = ok(await owner.call(`/invoicing/invoices/${draft.id}/issue`, 'POST', {}));
    const entry = await entryFor(owner, 'invoice', (e) => e.source_ref === invoice.id);
    assert.equal(entry.total, '11800.00');
    assert.equal(line(entry, 'Accounts receivable').debit, '11800.00');
    assert.equal(line(entry, 'Sales').credit, '10000.00');
    assert.equal(line(entry, 'GST payable').credit, '1800.00');
  });

  await t.test('a payment moves the money from receivable to bank', async () => {
    const payment = ok(await owner.call('/invoicing/payments', 'POST', { amount: '11800', method: 'upi', allocations: [{ invoice_id: invoice.id, amount: '11800' }] }), 201);
    const entry = await entryFor(owner, 'payment', (e) => e.source_ref === payment.payment?.id || e.source_ref === payment.id);
    assert.equal(line(entry, 'Bank').debit, '11800.00');
    assert.equal(line(entry, 'Accounts receivable').credit, '11800.00');
  });

  await t.test('goods received and a till sale post too', async () => {
    const pen = ok(await owner.call('/erp/products', 'POST', { name: 'Pen', sale_price: 100, cost_price: 50, tax_rate: 18 }), 201);
    const vendor = ok(await owner.call('/erp/vendors', 'POST', { name: `Vendor ${stamp}` }), 201);
    const po = ok(await owner.call('/erp/purchase-orders', 'POST', { vendor_id: vendor.id, lines: [{ product_id: pen.id, quantity: 10, unit_price: 50, tax_rate: 18 }] }), 201);
    ok(await owner.call(`/erp/purchase-orders/${po.id}/approve`, 'POST', {}));
    ok(await owner.call(`/erp/purchase-orders/${po.id}/receive`, 'POST', {}));
    const received = await entryFor(owner, 'purchase');
    assert.equal(line(received, 'Inventory').debit, '500.00');
    assert.equal(line(received, 'GST input credit').debit, '90.00');
    assert.equal(line(received, 'Accounts payable').credit, '590.00');

    const register = ok(await owner.call('/pos/registers', 'POST', { name: 'Till' }), 201);
    const session = ok(await owner.call(`/pos/registers/${register.id}/open`, 'POST', {}), 201);
    const sale = ok(await owner.call('/pos/sales', 'POST', { session_id: session.id, client_ref: `fin-${stamp}-01`, lines: [{ product_id: pen.id, quantity: 2 }], payment_method: 'cash' }), 201);
    const posted = await entryFor(owner, 'pos', (e) => e.source_ref === sale.id);
    assert.equal(line(posted, 'Cash in hand').debit, '236.00');
    assert.equal(line(posted, 'GST payable').credit, '36.00');
  });

  await t.test('manual journals must balance; mistakes are reversed, not deleted', async () => {
    const accounts = ok(await owner.call('/accounting/accounts?limit=100'));
    const rent = accounts.find((a) => a.system_key === 'rent');
    const bank = accounts.find((a) => a.system_key === 'bank');
    const unbalanced = await owner.call('/accounting/journal', 'POST', { memo: 'Rent', lines: [{ account_id: rent.id, debit: '25000' }, { account_id: bank.id, credit: '2500' }] });
    assert.equal(unbalanced.status, 400);
    assert.equal(unbalanced.error.details.code, 'unbalanced');
    assert.equal((await member.call('/accounting/journal', 'POST', { memo: 'Rent', lines: [{ account_id: rent.id, debit: '25000' }, { account_id: bank.id, credit: '25000' }] })).status, 403, 'posting is not a member verb');
    const entry = ok(await owner.call('/accounting/journal', 'POST', { memo: 'September rent', lines: [{ account_id: rent.id, debit: '25000' }, { account_id: bank.id, credit: '25000' }] }), 201);
    const reversal = ok(await owner.call(`/accounting/journal/${entry.id}/reverse`, 'POST', {}));
    assert.equal(reversal.source, 'reversal');
    assert.equal((await owner.call(`/accounting/journal/${entry.id}/reverse`, 'POST', {})).status, 400);
    assert.equal((await owner.call(`/accounting/accounts/${rent.id}`, 'DELETE')).status, 400, 'system accounts stay');
  });

  await t.test('trial balance balances; the balance sheet balances; the P&L shows the profit', async () => {
    const tb = ok(await owner.call('/accounting/reports/trial-balance'));
    assert.equal(tb.balanced, true);
    const bs = ok(await owner.call('/accounting/reports/balance-sheet'));
    assert.equal(bs.balanced, true);
    const pl = ok(await owner.call('/accounting/reports/profit-loss'));
    assert.equal(pl.total_income, '10200.00', '10,000 invoiced + 200 at the till');
    const overview = ok(await owner.call('/accounting/overview'));
    assert.equal(overview.cash_position, '12036.00', '11,800 banked + 236 cash');
  });

  await t.test('bank statements import once and reconcile', async () => {
    const bank = ok(await owner.call('/accounting/bank-accounts', 'POST', { name: 'HDFC current', account_last4: '4321' }), 201);
    const rows = [
      { date: new Date().toISOString().slice(0, 10), description: 'UPI Mehta Traders', amount: '11800' },
      { date: new Date().toISOString().slice(0, 10), description: 'SMS charges', amount: '-59' },
    ];
    assert.equal(ok(await owner.call(`/accounting/bank-accounts/${bank.id}/import`, 'POST', { rows })).added, 2);
    assert.equal(ok(await owner.call(`/accounting/bank-accounts/${bank.id}/import`, 'POST', { rows })).added, 0, 'the same statement twice adds nothing');
    const list = await owner.call(`/accounting/bank-accounts/${bank.id}/transactions`);
    const receipt = list.data.find((x) => x.amount === '11800.00');
    const suggestion = list.meta.suggestions[receipt.id][0];
    assert.ok(suggestion, 'the payment posting is suggested');
    ok(await owner.call(`/accounting/bank-transactions/${receipt.id}/match`, 'POST', { line_id: suggestion.id }));
    const charges = list.data.find((x) => x.amount === '-59.00');
    const accounts = ok(await owner.call('/accounting/accounts?limit=100'));
    ok(await owner.call(`/accounting/bank-transactions/${charges.id}/post`, 'POST', { account_id: accounts.find((a) => a.system_key === 'bank_charges').id }));
    const after = await owner.call(`/accounting/bank-accounts/${bank.id}/transactions?status=unmatched`);
    assert.equal(after.data.length, 0);
  });
});

test('Asset Management: capitalise, depreciate once per month, dispose with a gain or loss', async (t) => {
  const { client: owner } = await workspace(APPS);
  const bought = new Date();
  bought.setMonth(bought.getMonth() - 2);
  const purchaseDate = `${bought.toISOString().slice(0, 7)}-05`;
  let laptop;

  await t.test('registering an asset can post its purchase', async () => {
    assert.equal((await owner.call('/assets/register', 'POST', { name: 'Bad', purchase_date: purchaseDate, cost: 1000, salvage_value: 1000, method: 'slm', useful_life_months: 12 })).status, 400);
    laptop = ok(await owner.call('/assets/register', 'POST', { name: 'MacBook Air', category: 'Computers', purchase_date: purchaseDate, cost: '120000', salvage_value: '12000', method: 'slm', useful_life_months: 36, paid_from: 'bank' }), 201);
    assert.match(laptop.number, /^FA-/);
    const detail = ok(await owner.call(`/assets/register/${laptop.id}`));
    assert.equal(detail.schedule[0].amount, '3000.00', '(1,20,000 − 12,000) / 36');
    assert.equal(detail.schedule.length, 36);
    const entries = ok(await owner.call('/accounting/journal?source=asset'));
    assert.equal(entries[0].total, '120000.00');
  });

  await t.test('depreciation catches up missed months and never runs twice', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const run = ok(await owner.call('/assets/depreciation/run', 'POST', { period }));
    assert.equal(run.posted, '9000.00', 'purchase month + two more');
    assert.equal(ok(await owner.call('/assets/depreciation/run', 'POST', { period })).posted, '0.00');
    const asset = ok(await owner.call(`/assets/register/${laptop.id}`));
    assert.equal(asset.book_value, '111000.00');
    assert.equal((await owner.call(`/assets/register/${laptop.id}`, 'PATCH', { cost: '100000' })).status, 400, 'cost is fixed once depreciated');
    const future = new Date();
    future.setMonth(future.getMonth() + 2);
    assert.equal((await owner.call('/assets/depreciation/run', 'POST', { period: future.toISOString().slice(0, 7) })).status, 400);
  });

  await t.test('disposal books the loss and closes the asset', async () => {
    const sold = ok(await owner.call(`/assets/register/${laptop.id}/dispose`, 'POST', { disposed_on: new Date().toISOString().slice(0, 10), amount: '100000', received_in: 'bank' }));
    assert.equal(sold.status, 'disposed');
    assert.equal(sold.gain_or_loss, '-11000.00');
    const bs = ok(await owner.call('/accounting/reports/balance-sheet'));
    assert.equal(bs.balanced, true);
    assert.equal((await owner.call(`/assets/register/${laptop.id}/dispose`, 'POST', { disposed_on: new Date().toISOString().slice(0, 10) })).status, 400);
  });
});

test('Recurring Billing: renewals invoice once, trials wait, cancellations take effect at renewal', async (t) => {
  const { client: owner } = await workspace(APPS);
  let plan, sub;

  await t.test('a subscription with no trial bills on its start date, once', async () => {
    plan = ok(await owner.call('/recurring/plans', 'POST', { name: 'Gym monthly', amount: '1500', interval: 'monthly', tax_rate: 18 }), 201);
    sub = ok(await owner.call('/recurring/subscriptions', 'POST', { customer_name: 'Anil Kapoor', customer_email: 'anil@example.com', plan_id: plan.id }), 201);
    assert.equal(sub.status, 'active');
    assert.equal(sub.mrr, '1500.00');
    const run = ok(await owner.call('/recurring/run', 'POST', {}));
    assert.equal(run.invoices, 1);
    assert.equal(ok(await owner.call('/recurring/run', 'POST', {})).invoices, 0, 'the same period is never billed twice');
    const detail = ok(await owner.call(`/recurring/subscriptions/${sub.id}`));
    assert.equal(detail.invoices.length, 1);
    assert.equal(detail.invoices[0].status, 'issued');
    assert.equal(detail.invoices[0].total, '1770.00');
    assert.ok(detail.next_billing_date.slice(0, 10) > new Date().toISOString().slice(0, 10));
  });

  await t.test('a trial is not billed until it ends', async () => {
    const trialPlan = ok(await owner.call('/recurring/plans', 'POST', { name: 'SaaS yearly', amount: '12000', interval: 'yearly', trial_days: 14 }), 201);
    const trial = ok(await owner.call('/recurring/subscriptions', 'POST', { customer_name: 'Neha Shah', plan_id: trialPlan.id, quantity: 3 }), 201);
    assert.equal(trial.status, 'trialing');
    ok(await owner.call('/recurring/run', 'POST', {}));
    assert.equal(ok(await owner.call(`/recurring/subscriptions/${trial.id}`)).invoices.length, 0);
    const metrics = ok(await owner.call('/recurring/revenue'));
    assert.equal(metrics.trialing, 1);
    assert.equal(metrics.mrr, '1500.00', 'trials are not revenue yet');
  });

  await t.test('pause, resume, change plan, cancel at period end', async () => {
    const yearly = ok(await owner.call('/recurring/plans', 'POST', { name: 'Gym yearly', amount: '15000', interval: 'yearly' }), 201);
    ok(await owner.call(`/recurring/subscriptions/${sub.id}/change-plan`, 'POST', { plan_id: yearly.id }));
    assert.equal(ok(await owner.call(`/recurring/subscriptions/${sub.id}`)).next_plan_name, 'Gym yearly');
    ok(await owner.call(`/recurring/subscriptions/${sub.id}/pause`, 'POST', {}));
    assert.equal(ok(await owner.call('/recurring/revenue')).paused, 1);
    ok(await owner.call(`/recurring/subscriptions/${sub.id}/resume`, 'POST', {}));
    const cancelled = ok(await owner.call(`/recurring/subscriptions/${sub.id}/cancel`, 'POST', { at_period_end: true, reason: 'Moving city' }));
    assert.equal(cancelled.status, 'active');
    assert.equal(cancelled.cancel_at_period_end, true);
    assert.equal((await owner.call(`/recurring/plans/${plan.id}`, 'DELETE')).status, 400, 'plans in use stay');
  });
});
