import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspace, invite, ok } from './helpers.js';

/**
 * One employee, one board; another employee, another board — and neither can
 * see, edit or be assigned the other's work. Owners see everything.
 */
test('private boards isolate employees from each other', async (t) => {
  const { client: owner, stamp } = await workspace(['tasks', 'hr']);
  const asha = await invite(owner, 'employee', `${stamp}-asha`);
  const ravi = await invite(owner, 'employee', `${stamp}-ravi`);
  const ashaId = ok(await asha.call('/me/workspace')).user.id;
  const raviId = ok(await ravi.call('/me/workspace')).user.id;
  let sales, ops, task;

  await t.test('boards are private by default and the creator owns them', async () => {
    sales = ok(await owner.call('/tasks/projects', 'POST', { name: 'Sales follow-ups', color: 'emerald' }), 201);
    ops = ok(await owner.call('/tasks/projects', 'POST', { name: 'Office operations' }), 201);
    assert.equal(sales.visibility, 'private');
    assert.equal(sales.my_role, 'owner');
    assert.equal(ok(await asha.call('/tasks/projects')).length, 0, 'nobody else sees a new private board');
  });

  await t.test('each employee gets exactly the board they are added to', async () => {
    ok(await owner.call(`/tasks/projects/${sales.id}/members/${ashaId}`, 'PUT', { role: 'editor' }));
    ok(await owner.call(`/tasks/projects/${ops.id}/members/${raviId}`, 'PUT', { role: 'editor' }));
    assert.deepEqual(ok(await asha.call('/tasks/projects')).map((b) => b.id), [sales.id]);
    assert.deepEqual(ok(await ravi.call('/tasks/projects')).map((b) => b.id), [ops.id]);
    assert.equal((await asha.call(`/tasks/projects/${ops.id}`)).status, 404);
    assert.equal((await asha.call(`/tasks?project_id=${ops.id}`)).status, 404);
  });

  await t.test('assignment is limited to people on the board', async () => {
    task = ok(await owner.call('/tasks', 'POST', { title: 'Call back Mehta & Sons', project_id: sales.id, assignee_id: ashaId }), 201);
    const wrong = await owner.call('/tasks', 'POST', { title: 'Not his board', project_id: sales.id, assignee_id: raviId });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.error.details?.code, 'not_on_board');
    assert.equal(ok(await asha.call('/tasks?mine=true')).length, 1);
    assert.equal((await ravi.call(`/tasks/${task.id}`)).status, 404);
    assert.equal((await ravi.call(`/tasks/${task.id}/comments`, 'POST', { body: 'peek' })).status, 404);
  });

  await t.test('editors work their own board and nobody else’s', async () => {
    ok(await asha.call('/tasks', 'POST', { title: 'Send quotation', project_id: sales.id }), 201);
    ok(await asha.call(`/tasks/${task.id}`, 'PATCH', { status: 'in_progress' }));
    assert.equal((await asha.call('/tasks', 'POST', { title: 'Sneak in', project_id: ops.id })).status, 404);
    assert.equal((await asha.call(`/tasks/projects/${sales.id}/members/${raviId}`, 'PUT', { role: 'editor' })).status, 403);
    assert.equal((await asha.call(`/tasks/projects/${sales.id}`, 'PATCH', { visibility: 'workspace' })).status, 403);
    assert.equal((await asha.call('/tasks/projects', 'POST', { name: 'My own board' })).status, 403);
  });

  await t.test('a personal to-do is private to its owner and assignee', async () => {
    const todo = ok(await asha.call('/tasks', 'POST', { title: 'Renew my ID card' }), 201);
    ok(await asha.call(`/tasks/${todo.id}`));
    assert.equal((await ravi.call(`/tasks/${todo.id}`)).status, 404);
    ok(await owner.call(`/tasks/${todo.id}`)); // owners see everything
  });

  await t.test('viewers read but cannot change; removal revokes access', async () => {
    ok(await owner.call(`/tasks/projects/${sales.id}/members/${raviId}`, 'PUT', { role: 'viewer' }));
    ok(await ravi.call(`/tasks/${task.id}`));
    assert.equal((await ravi.call(`/tasks/${task.id}`, 'PATCH', { status: 'done' })).status, 403);
    ok(await owner.call(`/tasks/projects/${sales.id}/members/${raviId}`, 'DELETE'));
    assert.equal((await ravi.call(`/tasks/${task.id}`)).status, 404);
  });

  await t.test('the last owner cannot be removed or demoted', async () => {
    const me = ok(await owner.call('/me/workspace')).user.id;
    // The workspace owner manages every board, so they are its only owner row here.
    assert.equal((await owner.call(`/tasks/projects/${sales.id}/members/${me}`, 'DELETE')).status, 400);
    assert.equal((await owner.call(`/tasks/projects/${sales.id}/members/${me}`, 'PUT', { role: 'editor' })).status, 400);
  });

  await t.test('being added to a board notifies the person', async () => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const inbox = ok(await asha.call('/notifications'));
    assert.ok(inbox.some((n) => n.kind === 'board.member_added'), JSON.stringify(inbox.map((n) => n.kind)));
  });
});
