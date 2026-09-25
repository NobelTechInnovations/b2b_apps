import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, invite, ok } from './helpers.js';
import { recordEvent } from '../services/audit/src/lib/consumer.js';
import { createDb } from '../packages/db-kit/src/index.js';

async function eventually(read, predicate) {
  for (let i = 0; i < 40; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail('Expected event delivery within 10 seconds');
}

test('shared audit and task notification flows', async t => {
  const { client: owner, stamp } = await workspace(['tasks']);
  const member = await invite(owner, 'member', stamp);
  const guest = await invite(owner, 'guest', stamp);
  const { client: other } = await workspace(['tasks']);
  const memberId = ok(await member.call('/me/workspace')).user.id;
  const task = ok(await owner.call('/tasks', 'POST', { title: 'Shared phase check', description: 'Private body not for audit', assignee_id: memberId }), 201);
  let auditRow;
  await t.test('creation delivers notification to assignee and not another user', async () => {
    const notices = await eventually(async () => ok(await member.call('/notifications')), rows => rows.some(r => r.link === `/tasks?task=${task.id}`));
    const notice = notices.find(r => r.link === `/tasks?task=${task.id}`);
    assert.equal(notice.kind, 'task.assigned');
    assert.equal(ok(await owner.call('/notifications')).some(r => r.id === notice.id), false);
    assert.equal(ok(await other.call('/notifications/read', 'POST', { ids: [notice.id] })).marked, 0);
    assert.equal(ok(await member.call('/notifications/read', 'POST', { ids: [notice.id] })).marked, 1);
  });
  await t.test('completion notifies the task creator', async () => {
    ok(await member.call(`/tasks/${task.id}`, 'PATCH', { status: 'done' }));
    const notices = await eventually(async () => ok(await owner.call('/notifications')), rows => rows.some(r => r.kind === 'task.completed' && r.link === `/tasks?task=${task.id}`));
    assert.equal(notices.filter(r => r.kind === 'task.completed' && r.link === `/tasks?task=${task.id}`).length, 1);
  });
  await t.test('published task events become scoped audit metadata', async () => {
    const rows = await eventually(async () => ok(await owner.call('/audit?event_type=tasks.task.created')), rows => rows.some(r => r.resource_id === task.id));
    auditRow = rows.find(r => r.resource_id === task.id);
    assert.equal(auditRow.actor_id, ok(await owner.call('/me/workspace')).user.id);
    assert.equal('data' in auditRow, false);
    assert.equal(JSON.stringify(rows).includes('Private body'), false);
    assert.equal(ok(await other.call('/audit')).some(r => r.event_id === auditRow.event_id), false);
    assert.equal((await guest.call('/audit')).status, 403);
  });
  await t.test('audit pagination, filters, validation and read-only API', async () => {
    const first = await owner.call('/audit?limit=1'); ok(first);
    assert.ok(first.meta.next_cursor);
    const second = ok(await owner.call(`/audit?limit=1&before=${first.meta.next_cursor}`));
    assert.notEqual(second[0].event_id, first.data[0].event_id);
    assert.equal(ok(await owner.call('/audit?from=2000-01-01&to=2000-01-02')).length, 0);
    assert.equal((await owner.call('/audit?from=2026-02-01&to=2026-01-01')).status, 400);
    assert.equal((await owner.call('/audit?before=9999999999999999999')).status, 400);
    assert.equal((await owner.call('/audit', 'POST', { event_type: 'fake' })).status, 404);
  });
  await t.test('redelivery is idempotent and database rejects mutation', async () => {
    if (!process.env.PG_HOST) process.loadEnvFile('.env');
    const db = createDb({ url: `postgres://${process.env.PG_USER}:${process.env.PG_PASSWORD}@${process.env.PG_HOST}:${process.env.PG_PORT}/nexus_audit`, appName: 'audit-regression' });
    try {
      const event = await db.one('SELECT * FROM audit_events WHERE event_id=$1', [auditRow.event_id]);
      await recordEvent(db, { id: event.event_id, type: event.event_type, org_id: event.org_id, actor_id: event.actor_id, occurred_at: event.occurred_at, data: { task_id: task.id } });
      assert.equal((await db.one('SELECT count(*)::int AS n FROM audit_events WHERE event_id=$1', [event.event_id])).n, 1);
      await assert.rejects(db.query('UPDATE audit_events SET actor_id=actor_id WHERE event_id=$1', [event.event_id]), /append-only/);
      // Trigger checks are rolled back even if the implementation regresses.
      for (const sql of ['DELETE FROM audit_events WHERE event_id=$1', 'TRUNCATE audit_events']) {
        const client = await db.pool.connect();
        try { await client.query('BEGIN'); await assert.rejects(client.query(sql, sql.includes('$1') ? [event.event_id] : []), /append-only/); }
        finally { await client.query('ROLLBACK'); client.release(); }
      }
    } finally { await db.pool.end(); }
  });
});
