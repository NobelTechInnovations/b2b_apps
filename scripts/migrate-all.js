import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createDb, runMigrations } from '../packages/db-kit/src/index.js';
import { loadRootEnv, databaseFor } from './lib/services.js';

const env = loadRootEnv();
for (const name of await readdir('services')) {
  const dir = path.resolve('services', name, 'migrations');
  if (!existsSync(dir)) continue;
  const { DATABASE_URL: url, DB_SCHEMA: schema } = databaseFor(name, env);
  const db = createDb({ url, appName: `migrate-${name}`, schema: schema || undefined, max: 1 });
  try { const result = await runMigrations({ db, dir }); console.log(`${name}: ${result.applied} new migrations`); }
  finally { await db.close(); }
}
