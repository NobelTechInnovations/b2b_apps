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
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { SERVICES, loadRootEnv, serviceEnv } from './lib/services.js';
import { createStartupProxy } from './lib/startup-proxy.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const base = loadRootEnv(ROOT);
const publicPort = base.PORT ?? '8080';
const proxyEnabled = base.API_STARTUP_PROXY === 'true';
const gatewayPort = proxyEnabled ? String(SERVICES.find((s) => s.name === 'gateway').port) : publicPort;
const stagger = Number(base.STARTUP_STAGGER_MS ?? 1500);
const children = new Set();
let proxy;
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

function start(service) {
  const env = serviceEnv(service, base);
  // Only the gateway's port is published by the platform; the others are
  // reachable inside the container alone (and still demand a token).
  if (service.name === 'gateway') env.PORT = gatewayPort;
  if (proxyEnabled) env.SERVICE_BIND_HOST = '127.0.0.1';
  // Tell everyone where the gateway lives inside the container.
  env.GATEWAY_URL = `http://localhost:${gatewayPort}`;

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

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// Platform services first, the gateway last, so its health check only goes
// green once everything behind it has started.
const order = [...SERVICES.filter((s) => s.name !== 'gateway'), SERVICES.find((s) => s.name === 'gateway')];
function startChildren() {
  order.forEach((service, index) => setTimeout(() => { if (!stopping) start(service); }, index * stagger));
  console.log(`Nexus API: starting ${order.length} services; gateway on :${gatewayPort}`);
}

if (proxyEnabled) {
  // Hostinger checks listen() in this process; a listening child does not count.
  proxy = createStartupProxy({ gatewayPort });
  proxy.on('error', (error) => {
    console.error(`API startup proxy failed: ${error.code ?? error.message}`);
    shutdown(1);
  });
  proxy.listen(Number(publicPort), '0.0.0.0', () => {
    console.log(`API startup proxy listening on :${publicPort}; waiting for the gateway on :${gatewayPort}`);
    startChildren();
  });
} else {
  startChildren();
}
