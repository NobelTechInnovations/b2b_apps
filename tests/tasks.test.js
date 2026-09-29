import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, workspace, invite, ok } from './helpers.js';

test('projects and tasks workflow with isolation and permission boundaries', async (t) => {
  const { client: owner, stamp } = await workspace(['tasks', 'crm', 'hr', 'documents']);
  const { client: other } = await workspace(['tasks', 'documents']);
  const me = ok(await owner.call('/me/workspace')).user.id;
  const otherUser = ok(await other.call('/me/workspace')).user.id;
  let project, task, child, milestone;
  await t.test('create project, milestone and assigned task', async () => {
    project = ok(await owner.call('/tasks/projects', 'POST', { name: 'Customer onboarding', due_date: '2026-10-15', visibility: 'workspace' }), 201);
    milestone = ok(await owner.call(`/tasks/projects/${project.id}/milestones`, 'POST', { title: 'Go live', due_date: '2026-10-12' }), 201);
    task = ok(await owner.call('/tasks', 'POST', { title: 'Prepare rollout', project_id: project.id, milestone_id: milestone.id, assignee_id: me, due_date: '2026-10-10', priority: 'high' }), 201);
    assert.equal(ok(await owner.call('/tasks?mine=true')).length, 1);
    assert.equal(ok(await owner.call('/tasks?due_from=2026-11-01&due_to=2026-11-30')).length, 0);
    assert.equal(ok(await owner.call('/tasks/projects'))[0].task_count, 1);
  });
  await t.test('cannot use another tenant project, task, assignee or milestone', async () => {
    assert.equal((await other.call(`/tasks/${task.id}`)).status, 404);
    assert.equal((await other.call(`/tasks/${task.id}`, 'PATCH', { title: 'Intrusion' })).status, 404);
    assert.equal((await other.call(`/tasks/${task.id}/comments`, 'POST', { body: 'intrusion' })).status, 404);
    assert.equal((await other.call(`/tasks/${task.id}/time`, 'POST', { minutes: 30, worked_on: '2026-09-23' })).status, 404);
    assert.equal((await other.call('/tasks', 'POST', { title: 'Intrusion', project_id: project.id })).status, 404);
    assert.equal((await other.call(`/tasks/milestones/${milestone.id}`, 'PATCH', { completed: true })).status, 404);
    assert.equal((await owner.call(`/tasks/${task.id}`, 'PATCH', { assignee_id: otherUser })).status, 400);
  });
  await t.test('subtasks enforce completion and project consistency', async () => {
    child = ok(await owner.call('/tasks', 'POST', { title: 'Verify checklist', parent_id: task.id }), 201);
    assert.equal(child.project_id, project.id);
    assert.equal((await owner.call(`/tasks/${task.id}`, 'PATCH', { status: 'done' })).status, 400);
    assert.equal((await owner.call(`/tasks/${task.id}`, 'DELETE')).status, 400);
    ok(await owner.call(`/tasks/${child.id}`, 'PATCH', { status: 'done' }));
    ok(await owner.call(`/tasks/${task.id}`, 'PATCH', { status: 'done' }));
    assert.equal((await owner.call(`/tasks/${child.id}`, 'PATCH', { status: 'todo' })).status, 400);
    ok(await owner.call(`/tasks/${task.id}`, 'PATCH', { status: 'in_progress' }));
    assert.equal(ok(await owner.call(`/tasks/${task.id}`)).completed_at, null);
  });
  await t.test('comments and time persist; invalid time is refused', async () => {
    ok(await owner.call(`/tasks/${task.id}/comments`, 'POST', { body: 'Customer confirmed the date.' }), 201);
    ok(await owner.call(`/tasks/${task.id}/time`, 'POST', { minutes: 45, worked_on: '2026-09-23', note: 'Planning call' }), 201);
    assert.equal((await owner.call(`/tasks/${task.id}/time`, 'POST', { minutes: -2, worked_on: '2026-09-23' })).status, 400);
    const detail = ok(await owner.call(`/tasks/${task.id}`));
    assert.equal(detail.comments.length, 1); assert.equal(detail.time_entries[0].minutes, 45);
    assert.equal((await owner.call('/tasks/time')).meta.minutes, 45);
  });
  await t.test('two task entries sum once into project time and respect filters', async () => {
    ok(await owner.call(`/tasks/${child.id}/time`, 'POST', { minutes: 30, worked_on: '2026-09-23' }), 201);
    const projectTime = await owner.call(`/tasks/time?project_id=${project.id}&mine=true`);
    assert.equal(projectTime.meta.minutes, 75);
    assert.equal(projectTime.data.length, 2);
    assert.equal(projectTime.data.every(entry => entry.project_id === project.id), true);
    assert.equal(ok(await owner.call('/tasks/projects')).find(p => p.id === project.id).logged_minutes, 75);
    assert.equal((await other.call(`/tasks/time?project_id=${project.id}`)).status, 404);
  });
  await t.test('CRM and HR source records are verified in the caller workspace', async () => {
    const lead = ok(await owner.call('/crm/leads', 'POST', { first_name: 'Customer', last_name: 'Lead' }), 201);
    const linked = ok(await owner.call('/tasks', 'POST', { title: 'Call customer', source_app: 'crm', source_type: 'lead', source_id: lead.id }), 201);
    assert.equal(linked.source_id, lead.id);
    assert.equal((await other.call('/tasks', 'POST', { title: 'Wrong workspace', source_app: 'crm', source_type: 'lead', source_id: lead.id })).status, 400);
    const employee = ok(await owner.call('/hr/employees', 'POST', { first_name: 'New', last_name: 'Colleague' }), 201);
    const hrTask = ok(await owner.call('/tasks', 'POST', { title: 'Issue access card', source_app: 'hr', source_type: 'employee', source_id: employee.id }), 201);
    assert.equal(hrTask.source_app, 'hr');
  });
  await t.test('document attachments preserve tenant boundaries', async () => {
    async function upload(client, name) {
      const form = new FormData(); form.append('file', new Blob(['Task attachment test'], { type: 'text/plain' }), name);
      const response = await fetch(`${API}/api/documents/upload`, { method: 'POST', headers: { cookie: client.cookie() }, body: form });
      assert.equal(response.status, 201); return (await response.json()).data;
    }
    const document = await upload(owner, 'checklist.txt');
    const foreignDocument = await upload(other, 'private.txt');
    ok(await owner.call(`/tasks/${task.id}/attachments`, 'POST', { document_id: document.id }), 201);
    assert.equal((await owner.call(`/tasks/${task.id}/attachments`, 'POST', { document_id: foreignDocument.id })).status, 400);
    assert.equal(ok(await owner.call(`/tasks/${task.id}`)).attachments.length, 1);
  });
  await t.test('guest reads but cannot mutate; employee sees open boards but cannot create them', async () => {
    const guest = await invite(owner, 'guest', `${stamp}-guest`);
    ok(await guest.call(`/tasks/${task.id}`));
    assert.equal((await guest.call('/tasks', 'POST', { title: 'Forbidden' })).status, 403);
    assert.equal((await guest.call(`/tasks/${task.id}`, 'PATCH', { status: 'done' })).status, 403);
    assert.equal((await guest.call(`/tasks/${task.id}/time`, 'POST', { minutes: 5, worked_on: '2026-09-23' })).status, 403);
    const employee = await invite(owner, 'employee', `${stamp}-employee`);
    ok(await employee.call(`/tasks/${task.id}`));
    assert.equal((await employee.call('/tasks/projects', 'POST', { name: 'Not mine to make' })).status, 403);
    assert.equal((await employee.call(`/tasks/projects/${project.id}`, 'PATCH', { name: 'Renamed' })).status, 403);
  });
  await t.test('project lifecycle and uninstall are enforced', async () => {
    assert.equal((await owner.call(`/tasks/projects/${project.id}`, 'PATCH', { status: 'completed' })).status, 400);
    ok(await owner.call(`/tasks/${task.id}`, 'PATCH', { status: 'done' }));
    ok(await owner.call(`/tasks/projects/${project.id}`, 'PATCH', { status: 'completed' }));
    assert.equal((await owner.call('/tasks', 'POST', { title: 'Closed project', project_id: project.id })).status, 400);
    ok(await owner.call(`/tasks/projects/${project.id}`, 'PATCH', { status: 'active' }));
    ok(await owner.call('/apps/tasks/uninstall', 'POST', {}));
    assert.equal((await owner.call('/tasks')).status, 403);
    ok(await owner.call('/apps/tasks/install', 'POST', {}));
    ok(await owner.call(`/tasks/${task.id}`));
  });
});
