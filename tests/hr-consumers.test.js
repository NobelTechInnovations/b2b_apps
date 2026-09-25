import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerConsumers } from '../services/hr/src/lib/consumers.js';

test('HR waits for every consumer before startup completes', async () => {
  const subscribed = [];
  await registerConsumers({ bus: { subscribe: async (_name, type) => {
    await new Promise(resolve => setImmediate(resolve)); subscribed.push(type);
  } } });
  assert.deepEqual(subscribed, ['tenancy.member.joined', 'payroll.salary.revised', 'tenancy.member.removed']);
});
test('HR consumer startup failure reaches the service bootstrap', async () => {
  await assert.rejects(registerConsumers({ bus: { subscribe: async () => { throw new Error('NATS unavailable'); } } }), /NATS unavailable/);
});
