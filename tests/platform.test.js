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
  await t.test('owner can manage billing; cycle and plan changes reprice items', async () => {
    const plans = ok(await owner.call('/plans'));
    assert.ok(plans.length);
    const before = ok(await owner.call('/subscriptions/current'));
    const crmMonthly = Number(before.items.find(i => i.app_slug === 'crm').unit_price);
    ok(await owner.call('/subscriptions/current', 'PATCH', { cycle: 'annual', seats: 26 }));
    const annual = ok(await owner.call('/subscriptions/current'));
    assert.equal(annual.seats, 26);
    assert.ok(Number(annual.items.find(i => i.app_slug === 'crm').unit_price) > crmMonthly);
    assert.equal(Number(annual.items.find(i => i.app_slug === 'documents').unit_price), 0);
    ok(await owner.call('/subscriptions/current', 'PATCH', { plan: 'starter', seats: 5, cycle: 'monthly' }));
    const starter = ok(await owner.call('/subscriptions/current'));
    assert.ok(Number(starter.items.find(i => i.app_slug === 'documents').unit_price) > 0);
  });
  await t.test('unbuilt apps cannot be quoted or purchased', async () => {
    assert.equal((await owner.call('/subscriptions/quote', 'POST', { plan: 'growth', app_slugs: ['manufacturing'] })).status, 400);
    assert.equal((await owner.call('/subscriptions/current/apps', 'POST', { app_slug: 'accounting' })).status, 400);
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
