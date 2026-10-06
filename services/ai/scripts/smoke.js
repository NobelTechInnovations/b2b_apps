import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { API, workspace, invite, ok, password } from '../../../scripts/lib/api-client.js';

if (!['localhost', '127.0.0.1'].includes(new URL(API).hostname)) throw new Error('This smoke test is restricted to a local API.');
const clients = [];
async function connect(token) {
  const client = new Client({ name: 'nexus-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client); return client;
}
async function tool(client, name, args = {}, error = false) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(result.isError), error, error ? 'Expected tool error' : result.content?.[0]?.text);
  return error ? result.content[0].text : JSON.parse(result.content[0].text);
}
const issue = async (client, allow_write = false) => ok(await client.call('/account/agent-connections', 'POST', { name: 'MCP local review', apps: ['tasks'], allow_write, expires_in_days: 7 }), 201);

try {
  const { client: owner, email, stamp } = await workspace(['tasks']);
  const orgA = ok(await owner.call('/me/workspace')).organization.id;
  const grant = await issue(owner, true);
  const agent = await connect(grant.token);
  assert.equal((await tool(agent, 'list_apps')).company_id, orgA);
  const actions = await tool(agent, 'find_actions', { app: 'tasks' });
  assert.ok(actions.total > 20);
  await tool(agent, 'describe_action', { action_id: 'tasks:POST:/tasks' });
  const task = (await tool(agent, 'write_action', { action_id: 'tasks:POST:/tasks', body: { title: 'Review AI integration', status: 'todo' } })).data;
  assert.equal(ok(await owner.call(`/tasks/${task.id}`)).title, 'Review AI integration');
  await tool(agent, 'write_action', { action_id: 'tasks:PATCH:/tasks/:taskId', params: { taskId: task.id }, body: { title: 'AI integration reviewed' } });
  assert.equal(ok(await owner.call(`/tasks/${task.id}`)).title, 'AI integration reviewed');
  console.log('PASS: official MCP client initializes, discovers schemas, creates, reads and updates a task');

  const ro = await issue(owner);
  const reader = await connect(ro.token);
  assert.ok(!(await reader.listTools()).tools.some((t) => t.name === 'write_action'));
  await tool(reader, 'write_action', { action_id: 'tasks:DELETE:/tasks/:taskId', params: { taskId: task.id } }, true);
  await tool(reader, 'find_actions', { app: 'hr' }, true);
  await tool(reader, 'read_action', { action_id: 'tasks:GET:/tasks/:taskId', params: { taskId: '../auth' } }, true);
  assert.equal((await tool(reader, 'read_action', { action_id: 'tasks:GET:/tasks/:taskId', params: { taskId: task.id } })).data.id, task.id);
  const listed = ok(await owner.call('/account/agent-connections'));
  assert.ok(listed.every((item) => !item.token && !item.token_hash && !item.session_id));
  console.log('PASS: read-only and app scopes enforced; token secret is never returned again');

  const { client: other } = await workspace(['tasks']);
  const foreignTask = ok(await other.call('/tasks', 'POST', { title: 'Other company only' }), 201);
  await tool(agent, 'read_action', { action_id: 'tasks:GET:/tasks/:taskId', params: { taskId: foreignTask.id } }, true);
  assert.equal((await other.call(`/account/agent-connections/${grant.id}`, 'DELETE')).status, 404);
  assert.equal((await other.call('/account/agent-connections')).data.some((c) => c.id === grant.id), false);
  console.log('PASS: foreign company records, connections and revocation are isolated');

  const colleague = await invite(owner, 'member', `${stamp}-mcp`);
  const colleagueGrant = await issue(colleague);
  const colleagueAgent = await connect(colleagueGrant.token);
  await tool(colleagueAgent, 'read_action', { action_id: 'tasks:GET:/tasks/:taskId', params: { taskId: task.id } }, true);
  const colleagueUser = ok(await colleague.call('/me/workspace')).user.id;
  const member = ok(await owner.call('/members')).find((m) => m.user_id === colleagueUser);
  ok(await owner.call(`/members/${member.id}`, 'DELETE'));
  await assert.rejects(colleagueAgent.listTools());
  console.log('PASS: another user cannot read a private task; membership removal stops the connection');

  ok(await owner.call(`/account/agent-connections/${ro.id}`, 'DELETE'));
  await assert.rejects(reader.listTools());
  const fakeOrigin = await fetch(`${API}/api/mcp`, { method: 'POST', headers: { authorization: `Bearer ${grant.token}`, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(fakeOrigin.status, 403);
  const cookieOnly = await fetch(`${API}/api/mcp`, { method: 'POST', headers: { cookie: owner.cookie(), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(cookieOnly.status, 401);
  console.log('PASS: revocation, origin validation and rejection of browser-cookie authentication');

  const status = ok(await owner.call('/ai/status'));
  if (!status.configured) assert.equal((await owner.call('/ai/chat', 'POST', { messages: [{ role: 'user', content: 'Help me' }] })).error.code, 'ai_not_configured');
  const audit = ok(await owner.call('/ai/activity'));
  assert.ok(audit.some((entry) => entry.action_id === 'tasks:POST:/tasks' && entry.status === 'completed'));
  assert.ok(audit.every((entry) => !entry.token && !entry.body));
  await writeFile('/tmp/nexus-ai-review-login.json', JSON.stringify({ url: 'http://localhost:3100/settings/ai', email, password, company_id: orgA }), { mode: 0o600 });
  // The review connection has proved its behavior. Leave no active test credentials.
  ok(await owner.call(`/account/agent-connections/${grant.id}`, 'DELETE'));
  console.log('PASS: audit history and honest missing-model-key state; review login saved locally');
} finally { await Promise.allSettled(clients.map((client) => client.close())); }
