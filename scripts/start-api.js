#!/usr/bin/env node
/**
 * Production entrypoint for the API: every service in one container.
 *
 * Each service still runs as its own process, on its own internal port, with
 * its own schema — exactly as in development. Only the gateway listens on the
 * public $PORT; the rest bind to localhost and are reachable only through it.
 * Railway (or any container host) sees one service with one health check.
 *
 * If any service exits, the whole container exits, so the platform restarts
 * it rather than leaving a gateway fronting a dead dependency.
 *
 * API_PROCESS_MODE=single runs every service inside this one Node process
 * instead (each still on its own loopback port, with its own schema). Shared
 * hosting such as Hostinger caps the number of processes and the memory, and
 * one process (about 400 MB for all services) fits; it is the default everywhere.
 * API_PROCESS_MODE=multi brings back one process per service.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { SERVICES, loadRootEnv, serviceEnv } from './lib/services.js';
import { createStartupProxy } from './lib/startup-proxy.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const base = loadRootEnv(ROOT);
const publicPort = base.PORT ?? '8080';
const proxyEnabled = base.API_STARTUP_PROXY === 'true';
const gatewayPort = proxyEnabled ? String(SERVICES.find((s) => s.name === 'gateway').port) : publicPort;
const stagger = Number(base.STARTUP_STAGGER_MS ?? 1500);
// One process unless asked otherwise: far less memory, and no process limits to hit.
const single = (base.API_PROCESS_MODE ?? 'single') !== 'multi';
// Hostinger (startup proxy + one process): no internal ports at all, the
// services call each other in memory. Elsewhere they use loopback ports.
if (single && proxyEnabled && base.API_INTERNAL_TRANSPORT !== 'tcp') base.NEXUS_IN_PROCESS = '1';
const children = new Set();
let proxy;
// What the startup page reports while the gateway is not answering.
const startup = { mode: null, started: [], starting: null, failed: null, since: new Date().toISOString() };

/** A failure in a few words: a code and a message without addresses or secrets. */
function reason(error) {
  const text = String(error?.message ?? error)
    .replace(/[a-z]+:\/\/[^\s'"]+/gi, '<url>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<address>')
    .replace(/[\w.-]+\.(com|co|in|net|io|org|supabase\.co)(:\d+)?\b/gi, '<host>')
    .slice(0, 200);
  return { code: error?.code ?? null, message: text };
}
let stopping = false;
let exitCode = 0;

for (const required of ['DATABASE_URL', 'SERVICE_TOKEN', 'COOKIE_SECRET']) {
  if (!base[required]) {
    console.error(`✖ ${required} is required`);
    process.exit(1);
  }
}
if (base.NODE_ENV === 'production' && base.BILLING_TEST_MODE === 'true' && !base.RAZORPAY_KEY_ID) {
  console.warn('! BILLING_TEST_MODE is on without Razorpay keys: invoices can be marked paid without payment.');
}
if (proxyEnabled && Number(publicPort) === Number(gatewayPort)) {
  console.error('API_STARTUP_PROXY requires a public PORT other than the internal gateway port 4000. Use PORT=3000 on Hostinger.');
  process.exit(1);
}

function envFor(service) {
  const env = serviceEnv(service, base);
  // Only the gateway's port is published by the platform; the others are
  // reachable inside the container alone (and still demand a token).
  if (service.name === 'gateway') env.PORT = gatewayPort;
  if (proxyEnabled || (single && service.name !== 'gateway')) env.SERVICE_BIND_HOST = '127.0.0.1';
  // Tell everyone where the gateway lives inside the container.
  env.GATEWAY_URL = `http://localhost:${gatewayPort}`;
  return env;
}

function start(service) {
  const env = envFor(service);

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'services', service.name),
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', (error) => {
    console.error(`Failed to start ${service.name}: ${error.code ?? error.message}`);
    if (error.code === 'EAGAIN') console.error('The host refused a new Node process. Check the hosting process/thread and memory limits.');
    shutdown(1);
  });
  child.on('close', (code, signal) => {
    children.delete(child);
    if (stopping) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    console.error(`✖ ${service.name} exited (${signal ?? code}); stopping the container`);
    shutdown(1);
  });
  children.add(child);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  proxy?.close();
  for (const child of children) child.kill('SIGTERM');
  if (children.size === 0) process.exit(code);
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 8_000).unref();
}

// In one process, each service handles the signals itself.
if (!single) {
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

// Platform services first, the gateway last, so its health check only goes
// green once everything behind it has started.
const order = [...SERVICES.filter((s) => s.name !== 'gateway'), SERVICES.find((s) => s.name === 'gateway')];
function startChildren() {
  if (single) return startInProcess();
  order.forEach((service, index) => setTimeout(() => { if (!stopping) start(service); }, index * stagger));
  console.log(`Nexus API: starting ${order.length} services; gateway on :${gatewayPort}`);
}

/**
 * Every service in this process, one after another. Each reads its settings
 * (port, schema, URLs) and its working folder while it starts, so those are
 * set for it alone; afterwards the shared settings are put back.
 */
async function startInProcess() {
  startup.mode = 'single';
  console.log(`Nexus API: starting ${order.length} services in one process; gateway on :${gatewayPort}`);
  for (const service of order) {
    if (stopping) return;
    const env = envFor(service);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(path.join(ROOT, 'services', service.name));
    startup.starting = service.name;
    try {
      await import(pathToFileURL(path.join(ROOT, 'services', service.name, 'src', 'index.js')).href);
    } catch (error) {
      console.error(`✖ ${service.name} failed to start: ${error.stack ?? error.message}`);
      startup.failed = { service: service.name, ...reason(error) };
      startup.starting = null;
      // Keep the startup page up long enough to read why, then let the host restart.
      setTimeout(() => process.exit(1), proxy ? 120_000 : 0);
      return;
    }
    startup.started.push(service.name);
    startup.starting = null;
    console.log(`✓ ${service.name}`);
  }
  process.chdir(ROOT);
  for (const key of Object.keys(process.env)) if (!(key in base)) delete process.env[key];
  Object.assign(process.env, base);
  await checkPorts();
}

/** Can each service be reached on its port? Shown on the startup page. */
async function checkPorts() {
  startup.node = process.version;
  if (base.NEXUS_IN_PROCESS === '1') { startup.transport = 'in-process'; console.log('✓ services connected in process'); return; }
  startup.ports = {};
  for (const service of order) {
    const port = Number(service.name === 'gateway' ? gatewayPort : service.port);
    startup.ports[service.name] = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (result) => { socket.destroy(); resolve(result); };
      socket.once('connect', () => done(`ok :${port}`));
      socket.once('error', (error) => done(`${error.code ?? 'error'} :${port}`));
      socket.setTimeout(3000, () => done(`timeout :${port}`));
    });
  }
  const failing = Object.entries(startup.ports).filter(([, result]) => !result.startsWith('ok'));
  console.log(failing.length ? `! unreachable: ${failing.map(([name, result]) => `${name} ${result}`).join(', ')}` : '✓ every service answers on its port');
}

if (proxyEnabled) {
  // Hostinger checks listen() in this process; a listening child does not count.
  proxy = createStartupProxy({ gatewayPort, status: () => startup });
  proxy.on('error', (error) => {
    console.error(`API startup proxy failed: ${error.code ?? error.message}`);
    shutdown(1);
  });
  proxy.listen(Number(publicPort), '0.0.0.0', () => {
    console.log(`API startup proxy listening on :${publicPort}; waiting for the gateway on :${gatewayPort}`);
    // Services open their own loopback ports even under Hostinger's listen()
    // takeover (see service-kit), so they can share this process.
    startChildren();
  });
} else {
  startChildren();
}
