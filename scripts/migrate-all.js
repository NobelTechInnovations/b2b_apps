import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createDb, runMigrations } from '../packages/db-kit/src/index.js';
if (existsSync('.env')) process.loadEnvFile('.env');
for (const name of await readdir('services')) {
  const dir = path.resolve('services', name, 'migrations');
  if (!existsSync(dir)) continue;
  const user = encodeURIComponent(process.env.PG_USER ?? 'nexus');
  const password = encodeURIComponent(process.env.PG_PASSWORD ?? 'nexus');
  const url = `postgres://${user}:${password}@${process.env.PG_HOST ?? 'localhost'}:${process.env.PG_PORT ?? '5433'}/nexus_${name}`;
  const db = createDb({ url, appName: `migrate-${name}` });
  try { const result = await runMigrations({ db, dir }); console.log(`${name}: ${result.applied} new migrations`); }
  finally { await db.close(); }
}
