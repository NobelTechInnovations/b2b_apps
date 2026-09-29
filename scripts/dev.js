#!/usr/bin/env node
/**
 * Local development runner.
 *
 * Starts every service in one terminal with prefixed, colour-coded output.
 * Each service still runs as its own process with its own database — this is
 * a convenience for development, not a change in architecture.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SERVICES, loadRootEnv, serviceEnv } from './lib/services.js';

const ROOT = process.cwd();

const base = loadRootEnv(ROOT);
const WEB = { name: 'web', port: Number(base.WEB_PORT ?? 3000), colour: 95 };
const only = process.argv.slice(2);
const children = [];

function start(service) {
  const { name, colour, cwd } = service;
  const env = serviceEnv(service, base);

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

// On a shared hosted database every service opening its pool, running its
// migrations and creating the bus tables at the same instant can exceed the
// database's connection cap. Starting them a moment apart avoids the spike.
const stagger = Number(base.STARTUP_STAGGER_MS ?? (base.DATABASE_URL ? 1500 : 0));
for (const [index, service] of selected.entries()) {
  setTimeout(() => start(service), index * stagger);
}

if (!only.length && existsSync(path.join(ROOT, 'apps', 'web', 'package.json'))) {
  const child = spawn('pnpm', ['dev'], {
    cwd: path.join(ROOT, 'apps', 'web'),
    env: { ...base, PORT: base.WEB_PORT ?? '3000' },
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
