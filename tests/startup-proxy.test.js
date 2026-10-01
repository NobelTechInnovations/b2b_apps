import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStartupProxy } from '../scripts/lib/startup-proxy.js';

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, { method = 'GET', url = '/healthz', headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('startup proxy reports unavailable until the gateway listens and after it stops', async (t) => {
  const gateway = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'gateway' }));
  });
  const gatewayPort = await listen(gateway);
  await close(gateway);
  const proxy = createStartupProxy({ gatewayPort });
  const publicPort = await listen(proxy);
  t.after(() => close(proxy));
  t.after(() => close(gateway));

  const starting = await request(publicPort);
  assert.equal(starting.status, 503);
  assert.equal(starting.headers['cache-control'], 'no-store');
  assert.equal(starting.headers['retry-after'], '3');
  assert.equal(JSON.parse(starting.body).error.code, 'api_unavailable');

  await listen(gateway, gatewayPort);
  const ready = await request(publicPort);
  assert.equal(ready.status, 200);
  assert.deepEqual(JSON.parse(ready.body), { status: 'ok', service: 'gateway' });

  await close(gateway);
  assert.equal((await request(publicPort)).status, 503);
});

test('startup proxy preserves bodies, tenant headers, redirects and multiple login cookies', async (t) => {
  let received;
  const gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    res.writeHead(307, {
      location: '/dashboard',
      'set-cookie': ['nx_at=test-access; HttpOnly; Secure', 'nx_rt=test-refresh; HttpOnly; Secure'],
      connection: 'close, x-internal-hop',
      'x-internal-hop': 'must-not-forward',
    });
    res.end('redirect');
  });
  const gatewayPort = await listen(gateway);
  const proxy = createStartupProxy({ gatewayPort });
  const publicPort = await listen(proxy);
  t.after(() => close(proxy));
  t.after(() => close(gateway));

  const body = Buffer.alloc(128 * 1024, 0xab);
  const result = await request(publicPort, {
    method: 'POST', url: '/api/upload?name=report%20one', body,
    headers: {
      host: 'company.example.test',
      'content-type': 'application/octet-stream',
      cookie: 'nx_at=test-access',
      'x-forwarded-proto': 'https',
      connection: 'close, x-client-hop',
      'x-client-hop': 'must-not-forward',
    },
  });
  assert.equal(result.status, 307);
  assert.equal(result.headers.location, '/dashboard');
  assert.deepEqual(result.headers['set-cookie'], ['nx_at=test-access; HttpOnly; Secure', 'nx_rt=test-refresh; HttpOnly; Secure']);
  assert.equal(result.headers['x-internal-hop'], undefined);
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/api/upload?name=report%20one');
  assert.equal(received.headers.host, 'company.example.test');
  assert.equal(received.headers.cookie, 'nx_at=test-access');
  assert.equal(received.headers['x-forwarded-proto'], 'https');
  assert.equal(received.headers['x-client-hop'], undefined);
  assert.deepEqual(received.body, body);
});

// Run the real entrypoint with a fixture registry, never the configured database.
async function entryFixture(t, hook = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts', 'lib'), { recursive: true });
  for (const file of ['start-api.js', 'lib/startup-proxy.js']) {
    await copyFile(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(root, 'scripts', file));
  }
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'scripts/lib/services.js'), `
    export const SERVICES = [{ name: 'gateway', port: 4000 }, { name: 'identity', port: 4001 }];
    export const loadRootEnv = () => ({ ...process.env });
    export const serviceEnv = (service, env) => ({ ...env, PORT: String(service.port) });
  `);
  await mkdir(path.join(root, 'services/identity/src'), { recursive: true });
  await writeFile(path.join(root, 'services/identity/src/index.js'), 'process.exit(7);');
  await writeFile(path.join(root, 'observe.js'), `
    import http from 'node:http';
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      console.log('ENTRY_LISTEN_CALLED');
      return listen.apply(this, args);
    };
    ${hook}
  `);
  return root;
}

async function runEntry(t, root, proxyEnabled) {
  const child = spawn(process.execPath, ['--import', path.join(root, 'observe.js'), path.join(root, 'scripts/start-api.js')], {
    // Explicit fixture-only settings ensure tests cannot touch production services.
    env: {
      PATH: process.env.PATH,
      PORT: '0',
      API_STARTUP_PROXY: String(proxyEnabled),
      STARTUP_STAGGER_MS: '30000',
      DATABASE_URL: 'postgresql://fixture-only.invalid/db',
      COOKIE_SECRET: 'fixture-only',
      SERVICE_TOKEN: 'fixture-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const started = performance.now();
  let output = '';
  let listenedAt;
  const collect = (chunk) => {
    output += chunk;
    if (listenedAt === undefined && output.includes('ENTRY_LISTEN_CALLED')) listenedAt = performance.now() - started;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const [code] = await once(child, 'close');
  return { code, output, listenedAt };
}

test('Hostinger mode calls listen promptly in the entry process and stops when a child fails', { timeout: 5000 }, async (t) => {
  const root = await entryFixture(t);
  const result = await runEntry(t, root, true);
  assert.ok(result.listenedAt < 3000, result.output);
  assert.ok(result.output.indexOf('ENTRY_LISTEN_CALLED') < result.output.indexOf('starting 2 services'));
  assert.match(result.output, /identity exited \(7\)/);
  assert.equal(result.code, 1);
});

test('normal container mode leaves the public listener to the gateway', { timeout: 5000 }, async (t) => {
  const root = await entryFixture(t);
  const result = await runEntry(t, root, false);
  assert.equal(result.listenedAt, undefined);
  assert.match(result.output, /identity exited \(7\)/);
  assert.equal(result.code, 1);
});

test('a spawn failure names the service, explains EAGAIN and exits without an unhandled error', { timeout: 5000 }, async (t) => {
  const root = await entryFixture(t, `
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.spawn = () => {
      const child = new EventEmitter();
      child.kill = () => false;
      process.nextTick(() => {
        child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
        child.emit('close', -1, null);
      });
      return child;
    };
    syncBuiltinESMExports();
  `);
  const result = await runEntry(t, root, true);
  assert.equal(result.code, 1);
  assert.match(result.output, /Failed to start identity: EAGAIN/);
  assert.match(result.output, /hosting process\/thread and memory limits/);
  assert.doesNotMatch(result.output, /Unhandled 'error' event/);
});
