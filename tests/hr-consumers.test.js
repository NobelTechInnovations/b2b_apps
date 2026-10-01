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

/** Run the member-joined handler with stand-ins for the bus, database and people list. */
async function joined({ roles, invitedMatch = null, usesHr = true }) {
  const handlers = {};
  const added = [];
  const db = {
    one: async (sql) => (sql.includes('UPDATE employees') ? invitedMatch : sql.includes('leave_types') ? { yes: usesHr } : null),
    query: async () => ({ rows: [] }),
  };
  const workspacePeople = { add: async (_db, args) => { added.push(args); return { created: 1, linked: 0 }; } };
  await registerConsumers({ bus: { subscribe: async (_name, type, fn) => { handlers[type] = fn; } }, db, workspacePeople });
  await handlers['tenancy.member.joined']({ org_id: 'org_1', data: { user_id: 'usr_1', email: 'a@b.com', roles } });
  return added;
}

test('someone who joins becomes an employee once the workspace uses HR', async () => {
  assert.deepEqual((await joined({ roles: ['member'] })).map((a) => a.userIds), [['usr_1']]);
  assert.equal((await joined({ roles: ['guest'] })).length, 0, 'guests are not staff');
  assert.equal((await joined({ roles: ['member'], usesHr: false })).length, 0, 'a workspace not using HR is left alone');
  assert.equal((await joined({ roles: ['employee'], invitedMatch: { id: 'emp_1' } })).length, 0, 'a portal invitation links its own record');
});
