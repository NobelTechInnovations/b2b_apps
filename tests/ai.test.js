import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService, requirePermission } from '../packages/service-kit/src/index.js';
import { createActionEngine, buildActionRequest } from '../services/ai/src/lib/actions.js';
import { runAssistant } from '../services/ai/src/lib/assistant.js';
import { aiRoutes } from '../services/ai/src/routes.js';
import { hashAgentToken } from '../services/identity/src/routes/agents.js';
import { complete, resolveProvider } from '../services/ai/src/lib/provider.js';
import { mcpRequestAllowed } from '../packages/service-kit/src/mcp-policy.js';

const empty = { type: 'object', additionalProperties: false };
const read = { id: 'tasks:GET:/tasks/:taskId', app: 'tasks', permissions: ['tasks.tasks.view'], method: 'GET', path: '/tasks/:taskId', write: false,
  input: { params: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false }, query: empty, body: empty } };
const write = { ...read, id: 'tasks:PATCH:/tasks/:taskId', permissions: ['tasks.tasks.edit'], method: 'PATCH', write: true,
  input: { ...read.input, body: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false } } };
const config = { cookieSecret: 'test-only-cookie-secret', serviceToken: 'test-only-internal-token', tokenIssuer: 'http://identity.test', jwksUrl: 'http://identity.test/jwks', identityUrl: 'http://identity.test', tenancyUrl: 'http://tenancy.test', gatewayUrl: 'http://gateway.test', mcpAllowedOrigins: ['http://localhost:3100'] };

function fixture() {
  const requests = [], logs = [], proposals = [];
  const state = { allowed: true, permissions: ['tasks.tasks.view', 'tasks.tasks.edit'], apps: ['tasks'], revoked: false, responseOrg: 'org_a' };
  const connection = { id: 'agt_a', org_id: 'org_a', user_id: 'usr_a', apps: ['tasks'], allow_write: true };
  const db = { query: async (...args) => { logs.push(args); return {}; }, one: async (...args) => { proposals.push(args); return { id: 'aip_example' }; } };
  const fetcher = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/exchange')) return Response.json(state.revoked ? { error: { message: 'revoked' } } : { data: { access_token: 'scoped-jwt', connection } }, { status: state.revoked ? 401 : 200 });
    if (url.endsWith('/api/me/workspace')) return Response.json({ data: { organization: { id: state.responseOrg }, user: { id: 'usr_a' }, apps: state.apps, installed: state.apps } });
    if (url.includes('/internal/authz/')) return Response.json({ data: { allowed: state.allowed, permissions: state.permissions, is_owner: false } });
    if (url.endsWith('/internal/ai-capabilities')) return Response.json({ data: [read, write] });
    if (url.includes('/api/tasks/')) return Response.json({ data: { id: 'tsk_a', title: 'Company A task' } });
    throw new Error(`Unexpected request ${url}`);
  };
  const engine = createActionEngine({ config, db, fetcher, upstreams: { tasks: 'http://tasks.test' } });
  return { engine, db, requests, logs, proposals, state, connection };
}

test('capabilities advertise guarded JSON routes, excluding public and download surfaces', async () => {
  const app = await createService({ name: 'test', config });
  const guard = [app.loadContext, requirePermission('tasks.tasks.view')];
  app.get('/tasks', { preHandler: guard }, async () => ({}));
  app.post('/tasks/open', async () => ({}));
  app.get('/tasks/export.csv', { preHandler: guard }, async () => '');
  app.get('/tasks/private', { preHandler: guard, config: { ai: false } }, async () => ({}));
  assert.equal((await app.inject('/internal/ai-capabilities')).statusCode, 403);
  const response = await app.inject({ url: '/internal/ai-capabilities', headers: { 'x-nexus-service-token': config.serviceToken } });
  assert.deepEqual(response.json().data.map((a) => a.id), ['test:GET:/tasks']);
  await app.close();
});

test('connection is bound to company and user, with a fresh membership check', async () => {
  const f = fixture();
  const ctx = await f.engine.exchange(`nx_mcp_${'a'.repeat(43)}`);
  assert.equal(ctx.orgId, 'org_a');
  f.state.responseOrg = 'org_b';
  await assert.rejects(f.engine.exchange(`nx_mcp_${'a'.repeat(43)}`), /identity mismatch/);
  f.state.responseOrg = 'org_a'; f.state.allowed = false;
  await assert.rejects(f.engine.exchange(`nx_mcp_${'a'.repeat(43)}`), /no longer active/);
  f.state.revoked = true;
  await assert.rejects(f.engine.exchange(`nx_mcp_${'a'.repeat(43)}`), /revoked/);
  await assert.rejects(f.engine.exchange('browser-jwt'), /MCP connection token/);
});

test('read-only, app scope and removed permissions are enforced before business requests', async () => {
  const f = fixture(); f.connection.allow_write = false;
  let ctx = await f.engine.context('jwt', f.connection);
  assert.equal((await f.engine.tool(ctx, 'find_actions', { app: 'tasks' })).total, 1);
  await assert.rejects(f.engine.tool(ctx, 'write_action', { action_id: write.id, params: { taskId: 'tsk_a' }, body: { title: 'New title' } }), /Permitted action/);
  await assert.rejects(f.engine.tool(ctx, 'find_actions', { app: 'hr' }), /outside/);
  f.state.permissions = [];
  ctx = await f.engine.context('jwt', f.connection);
  await assert.rejects(f.engine.tool(ctx, 'read_action', { action_id: read.id, params: { taskId: 'tsk_a' } }), /Permitted action/);
  assert.equal(f.requests.filter((r) => r.url.includes('/api/tasks/')).length, 0);
});

test('arbitrary URLs, tenant overrides, path traversal, invalid fields and tool/method confusion fail', async () => {
  for (const taskId of ['../account', '%2Fauth', 'x?org_id=b', '//evil.test', 'x#y']) {
    assert.throws(() => buildActionRequest(read, { params: { taskId } }, 'org_a'), /path parameter/);
  }
  assert.throws(() => buildActionRequest(write, { params: { taskId: 'tsk_a' }, body: { org_id: 'org_b', title: 'X' } }, 'org_a'), /switch companies/);
  assert.throws(() => buildActionRequest(write, { params: { taskId: 'tsk_a' }, body: { title: '' } }, 'org_a'), /Invalid body/);
  const f = fixture(); const ctx = await f.engine.context('jwt', f.connection);
  await assert.rejects(f.engine.tool(ctx, 'read_action', { action_id: 'http://evil.test' }), /Action not found/);
  await assert.rejects(f.engine.tool(ctx, 'read_action', { action_id: write.id }), /Use read_action/);
});

test('MCP execution reuses gateway authorization; assistant writes only create proposals', async () => {
  const f = fixture(); const ctx = await f.engine.context('private-jwt', f.connection);
  await f.engine.tool(ctx, 'write_action', { action_id: write.id, params: { taskId: 'tsk_a' }, body: { title: 'Updated' } });
  const calls = f.requests.filter((r) => r.url.includes('/api/tasks/'));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers.authorization, 'Bearer private-jwt');
  assert.equal(calls[0].options.headers['x-nexus-org'], undefined);
  assert.ok(f.logs[0][1].includes('org_a')); assert.ok(f.logs[0][1].includes('usr_a'));
  const assistantCtx = await f.engine.context('private-jwt');
  const result = await f.engine.tool(assistantCtx, 'write_action', { action_id: write.id, params: { taskId: 'tsk_a' }, body: { title: 'Proposed' } }, { propose: true });
  assert.equal(result.proposal.id, 'aip_example');
  assert.equal(f.requests.filter((r) => r.url.includes('/api/tasks/')).length, 1);
  assert.ok(f.proposals[0][1].includes('org_a'));
});

test('assistant sends no credentials to the model; guidance mode has no tools', async () => {
  const f = fixture(); const ctx = await f.engine.context('secret-session');
  let sent;
  const result = await runAssistant({ config: { ...config, aiApiKey: 'server-key', aiBaseUrl: 'https://provider.test/v1', aiModel: 'nemotron' }, engine: f.engine, ctx,
    messages: [{ role: 'user', content: 'What is task priority?' }], page: '/tasks', field: 'Priority', fetcher: async (_url, options) => {
      sent = JSON.parse(options.body); assert.equal(options.headers.authorization, 'Bearer server-key');
      return Response.json({ choices: [{ message: { content: 'Priority indicates urgency.' } }] });
    } });
  assert.equal(sent.tools, undefined);
  assert.ok(!JSON.stringify(sent).includes('secret-session'));
  assert.ok(!JSON.stringify(sent).includes('server-key'));
  assert.match(result.reply, /urgency/);
  await assert.rejects(runAssistant({ config, engine: f.engine, ctx, messages: [] }), { code: 'ai_not_configured' });
});

test('MCP stateless initialization/list/call use the official transport and reject missing/revoked tokens', async () => {
  const f = fixture();
  const app = await createService({ name: 'ai', config, db: f.db });
  await app.register(aiRoutes, { engine: f.engine });
  const headers = { 'x-nexus-service-token': config.serviceToken, authorization: `Bearer nx_mcp_${'a'.repeat(43)}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  const rpc = (method, params = {}, extra = {}) => app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, ...extra }, payload: { jsonrpc: '2.0', id: 1, method, params } });
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } });
  assert.equal(init.statusCode, 200, init.body); assert.equal(init.json().result.serverInfo.name, 'nexus');
  assert.equal((await rpc('tools/list')).json().result.tools.length, 5);
  const result = (await rpc('tools/call', { name: 'list_apps', arguments: {} })).json().result;
  assert.equal(JSON.parse(result.content[0].text).company_id, 'org_a');
  assert.equal((await rpc('tools/list', {}, { authorization: '' })).statusCode, 401);
  assert.equal((await rpc('tools/list', {}, { origin: 'https://evil.test' })).statusCode, 403);
  f.connection.allow_write = false;
  assert.equal((await rpc('tools/list')).json().result.tools.some((t) => t.name === 'write_action'), false);
  f.state.revoked = true;
  assert.equal((await rpc('tools/list')).statusCode, 401);
  await app.close();
});

test('tokens are hashed deterministically and cannot be recovered from stored value', () => {
  assert.equal(hashAgentToken('secret').length, 64);
  assert.equal(hashAgentToken('secret'), hashAgentToken('secret'));
  assert.notEqual(hashAgentToken('secret'), hashAgentToken('different'));
});

test('normal chat accepts empty/omitted field context and returns a real model answer', async () => {
  const f = fixture();
  const app = await createService({ name: 'ai', config: { ...config, nvidiaApiKey: 'test-provider-key' }, db: f.db });
  app.loadContext = async (r) => { r.ctx = { orgId: 'org_a', userId: 'usr_a' }; };
  let called = 0;
  await app.register(aiRoutes, { engine: f.engine, modelFetcher: async () => {
    called += 1; return Response.json({ choices: [{ message: { content: 'Start with your company settings.' } }] });
  } });
  for (const context of [{ page: '/settings/ai', field: '' }, { page: '', field: '' }, {}]) {
    const result = await app.inject({ method: 'POST', url: '/ai/chat', headers: { authorization: 'Bearer test' }, payload: { messages: [{ role: 'user', content: 'Help me set up my company' }], ...context } });
    assert.equal(result.statusCode, 200, result.body);
    assert.match(result.json().data.reply, /company settings/);
  }
  const empty = await app.inject({ method: 'POST', url: '/ai/chat', payload: { messages: [{ role: 'user', content: '' }] } });
  assert.equal(empty.statusCode, 400); assert.equal(called, 3);
  const status = (await app.inject('/ai/status')).json().data;
  assert.equal(status.configured, true); assert.equal(status.verified, false); assert.equal(status.provider, 'nvidia');
  const check = await app.inject({ method: 'POST', url: '/ai/check' });
  assert.equal(check.json().data.verified, true);
  await app.close();
});

test('provider errors reach the UI without upstream response bodies or credentials', async () => {
  const f = fixture();
  const app = await createService({ name: 'ai', config: { ...config, nvidiaApiKey: 'sensitive-key' }, db: f.db });
  app.loadContext = async (r) => { r.ctx = { orgId: 'org_a', userId: 'usr_a' }; };
  await app.register(aiRoutes, { engine: f.engine, modelFetcher: async () => Response.json({ error: 'sensitive-key should never be shown' }, { status: 401 }) });
  const result = await app.inject({ method: 'POST', url: '/ai/chat', headers: { authorization: 'Bearer test' }, payload: { messages: [{ role: 'user', content: 'Hello' }], field: '' } });
  assert.equal(result.statusCode, 502); assert.equal(result.json().error.code, 'ai_auth_failed');
  assert.ok(!result.body.includes('sensitive-key')); assert.match(result.json().error.message, /key or its permissions/);
  await app.close();
});

test('Anthropic uses its own key and native Messages/tool-result protocol', async () => {
  const f = fixture(); const ctx = await f.engine.context('session-jwt');
  const providerConfig = { ...config, aiProvider: 'anthropic', anthropicApiKey: 'sk-ant-test', supportAiModel: 'claude-test' };
  let round = 0;
  const result = await runAssistant({ config: providerConfig, engine: f.engine, ctx, useData: true,
    messages: [{ role: 'user', content: 'What apps can I use?' }], fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'sk-ant-test'); assert.equal(options.headers.authorization, undefined);
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      assert.ok(body.system.includes('Nexus')); assert.equal(body.model, 'claude-test');
      assert.equal(body.messages.some((m) => m.role === 'system'), false);
      assert.ok(body.tools[0].input_schema);
      round += 1;
      if (round === 1) return Response.json({ content: [{ type: 'tool_use', id: 'call_1', name: 'list_apps', input: {} }] });
      assert.equal(body.messages.at(-2).content[0].type, 'tool_use');
      assert.equal(body.messages.at(-1).content[0].type, 'tool_result');
      assert.equal(body.messages.at(-1).content[0].tool_use_id, 'call_1');
      return Response.json({ content: [{ type: 'text', text: 'You can use Tasks.' }] });
    } });
  assert.equal(result.reply, 'You can use Tasks.'); assert.equal(round, 2);
});

test('provider selection preserves legacy NVIDIA config and refuses crossed keys', async () => {
  assert.equal(resolveProvider({ aiApiKey: 'legacy-key', aiModel: 'nvidia/test' }).provider, 'nvidia');
  assert.equal(resolveProvider({ aiProvider: 'anthropic', anthropicApiKey: 'sk-ant-valid', nvidiaApiKey: 'nvapi-other' }).key, 'sk-ant-valid');
  assert.equal(resolveProvider({ aiProvider: 'anthropic', aiApiKey: 'nvapi-wrong' }).configured, false);
  assert.equal(resolveProvider({ aiProvider: 'nvidia', aiApiKey: 'sk-ant-wrong' }).configured, false);
  assert.equal(resolveProvider({ aiProvider: 'anthropic' }).configured, false);
  await assert.rejects(complete({ config: { aiProvider: 'anthropic', aiApiKey: 'nvapi-wrong' }, history: [], fetcher: () => { throw new Error('must not send an NVIDIA key to Anthropic'); } }), { code: 'ai_not_configured' });
  assert.throws(() => resolveProvider({ aiProvider: 'unknown' }), /AI_PROVIDER/);
});

test('temporary provider overload is retried once and empty responses do not fake success', async () => {
  let attempts = 0;
  const cfg = { nvidiaApiKey: 'test-key' };
  const result = await complete({ config: cfg, history: [], wait: async () => {}, fetcher: async () => {
    attempts += 1;
    return attempts === 1 ? Response.json({}, { status: 503 }) : Response.json({ choices: [{ message: { content: 'OK' } }] });
  } });
  assert.equal(attempts, 2); assert.equal(result.content, 'OK');
  attempts = 0;
  await assert.rejects(complete({ config: cfg, history: [], wait: async () => {}, fetcher: async () => { attempts += 1; return Response.json({}, { status: 503 }); } }), { code: 'ai_provider_overloaded' });
  assert.equal(attempts, 2);
  await assert.rejects(complete({ config: cfg, history: [], fetcher: async () => Response.json({ choices: [{ message: { content: '', reasoning_content: 'Hidden reasoning is not a reply' } }] }) }), { code: 'model_response_empty' });
});

test('MCP accepts configured company domains while rejecting spoofed suffixes and origins', () => {
  const env = { APP_URL: 'https://kartikmaandothiya.fun', ROOT_DOMAIN: 'kartikmaandothiya.fun', MCP_ALLOWED_HOSTS: 'localhost' };
  assert.equal(mcpRequestAllowed({ host: 'flp-worldwide-9491.kartikmaandothiya.fun' }, env), true);
  assert.equal(mcpRequestAllowed({ host: 'localhost:4000', origin: 'https://flp-worldwide-9491.kartikmaandothiya.fun' }, env), true);
  for (const host of ['evil.example', 'kartikmaandothiya.fun.evil.example', 'a.b.kartikmaandothiya.fun', 'evil@localhost', 'localhost/path']) assert.equal(mcpRequestAllowed({ host }, env), false, host);
  for (const origin of ['null', 'https://evil.example', 'https://kartikmaandothiya.fun/attacker', 'http://flp-worldwide-9491.kartikmaandothiya.fun', 'https://flp-worldwide-9491.kartikmaandothiya.fun:8443']) assert.equal(mcpRequestAllowed({ origin }, env), false, origin);
  assert.equal(mcpRequestAllowed({ host: 'flp-worldwide-9491.kartikmaandothiya.fun' }, {}), false);
  assert.equal(mcpRequestAllowed({ host: 'flp-worldwide-9491.kartikmaandothiya.fun' }, { MCP_PUBLIC_URL: 'https://flp-worldwide-9491.kartikmaandothiya.fun/api/mcp' }), true);
});
