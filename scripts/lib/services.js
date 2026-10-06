/**
 * The deployable units and how each one is configured.
 *
 * Shared by the local runner (scripts/dev.js), the migration runner and the
 * single-container production entrypoint (scripts/start-api.js), so the three
 * can never disagree about a port or a database.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SERVICES = [
  { name: 'identity', port: 4001, db: 'identity', colour: 35 },
  { name: 'tenancy', port: 4002, db: 'tenancy', colour: 36 },
  { name: 'catalog', port: 4003, db: 'catalog', colour: 33 },
  { name: 'billing', port: 4004, db: 'billing', colour: 32 },
  { name: 'audit', port: 4008, db: 'audit', colour: 90 },
  { name: 'ai', port: 4009, db: 'ai', colour: 35 },
  { name: 'notifier', port: 4006, db: 'notifier', colour: 90 },
  { name: 'gateway', port: 4000, db: null, colour: 34 },
  // Business apps. Ports match the registry order the gateway derives.
  { name: 'tasks', port: 4034, db: 'tasks', colour: 91 },
  { name: 'helpdesk', port: 4019, db: 'helpdesk', colour: 33 },
  { name: 'crm', port: 4010, db: 'crm', colour: 95 },
  { name: 'hr', port: 4030, db: 'hr', colour: 92 },
  { name: 'payroll', port: 4031, db: 'payroll', colour: 93 },
  { name: 'documents', port: 4036, db: 'documents', colour: 94 },
  { name: 'invoicing', port: 4022, db: 'invoicing', colour: 96 },
  { name: 'erp', port: 4040, db: 'erp', colour: 33 },
];

/** Parse a dotenv file without a dependency. Quotes are stripped. */
export function loadEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        const value = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        return [line.slice(0, index).trim(), value];
      }),
  );
}

export function loadRootEnv(root = process.cwd()) {
  return { ...loadEnvFile(path.join(root, '.env')), ...process.env };
}

/**
 * Where a service's tables live.
 *
 * Single-database mode (DATABASE_URL set, e.g. Supabase): every service shares
 * one database and owns one schema, `nexus_<service>`.
 * Local mode (PG_HOST…): one database per service, as docker-compose creates.
 */
export function databaseFor(db, env) {
  if (!db) return {};
  if (env.DATABASE_URL) {
    // DB_SCHEMA_PREFIX (`dev_`) lets a local copy share a hosted database with
    // a live one without touching its data: every schema gets its own name.
    return { DATABASE_URL: env.DATABASE_URL, DB_SCHEMA: `${env.DB_SCHEMA_PREFIX || 'nexus_'}${db}` };
  }
  const user = encodeURIComponent(env.PG_USER ?? 'nexus');
  const password = encodeURIComponent(env.PG_PASSWORD ?? 'nexus');
  return {
    DATABASE_URL: `postgres://${user}:${password}@${env.PG_HOST ?? 'localhost'}:${env.PG_PORT ?? '5433'}/nexus_${db}`,
    DB_SCHEMA: '',
  };
}

export function serviceEnv(service, env) {
  const out = { ...env, PORT: String(service.port), ...databaseFor(service.db, env) };
  // The Postgres bus needs a database even in the gateway, which has none.
  if (env.DATABASE_URL && !out.BUS_DATABASE_URL) out.BUS_DATABASE_URL = env.DATABASE_URL;
  if (!service.db) delete out.DB_SCHEMA;
  // Only the gateway remembers live sessions (briefly; revocations evict).
  // Everything behind it trusts the gateway's check for that request.
  if (service.name === 'gateway') out.SESSION_CACHE_MS ??= '15000';
  else delete out.SESSION_CACHE_MS;
  return out;
}
