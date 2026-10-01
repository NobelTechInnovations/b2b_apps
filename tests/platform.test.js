import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, workspace, invite, ok } from './helpers.js';

test('platform permission and lifecycle regressions', async (t) => {
  const { client: owner, stamp } = await workspace(['crm', 'hr', 'documents']);
  for (const role of ['employee', 'guest', 'member', 'admin']) {
    await t.test(`${role} cannot read or change billing`, async () => {
      const user = await invite(owner, role, `${stamp}-${role}`);
      for (const [path, method, body] of [
        ['/subscriptions/current', 'GET'],
        ['/subscriptions/current', 'PATCH', { seats: 26 }],
        ['/subscriptions/current/cancel', 'POST', { immediate: true }],
        ['/subscriptions/current/apps', 'POST', { app_slug: 'payroll' }],
        ['/subscriptions/current/apps/crm', 'DELETE'],
      ]) assert.equal((await user.call(path, method, body)).status, 403, `${role}: ${method} ${path}`);
    });
  }
  await t.test('owner can manage billing; plan and cycle changes re-price the open invoice', async () => {
    const plans = ok(await owner.call('/plans'));
    assert.deepEqual(plans.map((p) => p.slug), ['basic', 'business']);
    ok(await owner.call('/subscriptions/current', 'PATCH', { cycle: 'annual', seats: 26 }));
    const annual = ok(await owner.call('/subscriptions/current'));
    assert.equal(annual.seats, 26);
    assert.equal(annual.term_quote.months, 10);
    ok(await owner.call('/subscriptions/current', 'PATCH', { plan: 'basic', seats: 12, cycle: 'monthly' }));
    const basic = ok(await owner.call('/subscriptions/current'));
    assert.equal(basic.plan, 'basic');
    assert.ok(basic.items.every((item) => Number(item.unit_price) === 0), 'apps are never priced one by one');
    assert.equal(basic.invoices.filter((i) => i.status === 'open').length, 1, 'exactly one open term invoice');
  });
  await t.test('unbuilt apps cannot be quoted or purchased', async () => {
    assert.equal((await owner.call('/subscriptions/quote', 'POST', { plan: 'business', app_slugs: ['fieldservice'] })).status, 400);
    assert.equal((await owner.call('/subscriptions/current/apps', 'POST', { app_slug: 'bi' })).status, 400);
  });
  await t.test('uninstall disables API; reinstall restores access', async () => {
    ok(await owner.call('/apps/crm/uninstall', 'POST', {}));
    assert.equal((await owner.call('/crm/leads')).status, 403);
    ok(await owner.call('/apps/crm/install', 'POST', {}));
    ok(await owner.call('/crm/leads'));
  });
  await t.test('revoked access token fails even with a retained cookie', async () => {
    const cookie = owner.cookie();
    ok(await owner.call('/auth/logout', 'POST', {}));
    const replay = await fetch(`${API}/api/crm/leads`, { headers: { cookie } });
    assert.equal(replay.status, 401);
    assert.equal((await owner.call('/auth/refresh', 'POST', {})).status, 401);
  });
});
