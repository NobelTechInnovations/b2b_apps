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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const base = loadRootEnv(ROOT);
const publicPort = base.PORT ?? '8080';
const stagger = Number(base.STARTUP_STAGGER_MS ?? 1500);
const children = [];
let stopping = false;

for (const required of ['DATABASE_URL', 'SERVICE_TOKEN', 'COOKIE_SECRET']) {
  if (!base[required]) {
    console.error(`✖ ${required} is required`);
    process.exit(1);
  }
}
if (base.NODE_ENV === 'production' && base.BILLING_TEST_MODE === 'true' && !base.RAZORPAY_KEY_ID) {
  console.warn('! BILLING_TEST_MODE is on without Razorpay keys: invoices can be marked paid without payment.');
}

function start(service) {
  const env = serviceEnv(service, base);
  // Only the gateway's port is published by the platform; the others are
  // reachable inside the container alone (and still demand a token).
  if (service.name === 'gateway') env.PORT = publicPort;
  // Tell everyone where the gateway lives inside the container.
  env.GATEWAY_URL = `http://localhost:${publicPort}`;

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'services', service.name),
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`✖ ${service.name} exited (${signal ?? code}); stopping the container`);
    shutdown(1);
  });
  children.push(child);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 8_000).unref();
  let alive = children.length;
  for (const child of children) child.once('exit', () => { if (--alive === 0) process.exit(code); });
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// Platform services first, the gateway last, so its health check only goes
// green once everything behind it has started.
const order = [...SERVICES.filter((s) => s.name !== 'gateway'), SERVICES.find((s) => s.name === 'gateway')];
order.forEach((service, index) => setTimeout(() => { if (!stopping) start(service); }, index * stagger));
console.log(`Nexus API: starting ${order.length} services; gateway on :${publicPort}`);
