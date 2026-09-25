#!/usr/bin/env node
/**
 * Local development runner.
 *
 * Starts every service in one terminal with prefixed, colour-coded output.
 * Each service still runs as its own process with its own database — this is
 * a convenience for development, not a change in architecture.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const SERVICES = [
  { name: 'identity', port: 4001, db: 'identity', colour: 35 },
  { name: 'tenancy',  port: 4002, db: 'tenancy',  colour: 36 },
  { name: 'catalog',  port: 4003, db: 'catalog',  colour: 33 },
  { name: 'billing',  port: 4004, db: 'billing',  colour: 32 },
  { name: 'audit', port: 4008, db: 'audit', colour: 90 },
  { name: 'notifier', port: 4006, db: 'notifier', colour: 90 },
  { name: 'gateway',  port: 4000, db: null,       colour: 34 },
  // Business apps. Ports match the registry order the gateway derives.
  { name: 'tasks',    port: 4034, db: 'tasks', colour: 91 },
  { name: 'crm',      port: 4010, db: 'crm',      colour: 95 },
  { name: 'hr',       port: 4030, db: 'hr',       colour: 92 },
  { name: 'payroll',  port: 4031, db: 'payroll', colour: 93 },
  { name: 'documents',port: 4036, db: 'documents',colour: 94 },
  { name: 'invoicing',port: 4022, db: 'invoicing',colour: 96 },
];

const WEB = { name: 'web', port: 3000, colour: 95 };

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

const base = { ...process.env, ...loadEnv() };
const only = process.argv.slice(2);
const children = [];

function start({ name, port, db, colour, cwd }) {
  const env = { ...base, PORT: String(port) };
  if (db) {
    env.DATABASE_URL = `postgres://${base.PG_USER}:${base.PG_PASSWORD}@${base.PG_HOST}:${base.PG_PORT}/nexus_${db}`;
  }

  const child = spawn('node', ['--watch', '--watch-preserve-output', 'src/index.js'], {
    cwd: cwd ?? path.join(ROOT, 'services', name),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const tag = `\x1b[${colour}m${name.padEnd(9)}\x1b[0m │`;
  const pipe = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) target.write(`${tag} ${line}\n`);
    });
  };

  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) process.stdout.write(`${tag} exited with code ${code}\n`);
  });

  children.push(child);
}

const selected = only.length ? SERVICES.filter((s) => only.includes(s.name)) : SERVICES;

console.log('\n  Nexus — starting services\n');
for (const service of selected) {
  console.log(`  \x1b[${service.colour}m●\x1b[0m ${service.name.padEnd(10)} http://localhost:${service.port}`);
}
console.log('');

for (const service of selected) start(service);

if (!only.length && existsSync(path.join(ROOT, 'apps', 'web', 'package.json'))) {
  const child = spawn('pnpm', ['dev'], {
    cwd: path.join(ROOT, 'apps', 'web'),
    env: { ...base, PORT: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `\x1b[${WEB.colour}mweb      \x1b[0m │`;
  child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
  children.push(child);
}

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
