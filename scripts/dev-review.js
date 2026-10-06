// A local app backed by isolated schemas in the configured Supabase database.
// Never migrates the deployed nexus_* schemas or shares their event bus.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadRootEnv, loadEnvFile } from './lib/services.js';
const base = { ...loadRootEnv(), ...loadEnvFile('.env.local') };
if (!base.DATABASE_URL) throw new Error('Set DATABASE_URL for your Supabase project in .env.');
const env = { ...base,
  NODE_ENV: 'development', DB_SCHEMA_PREFIX: 'ai_review_', BUS_SCHEMA: 'ai_review_bus', BUS_DRIVER: 'postgres', BUS_DATABASE_URL: base.DATABASE_URL,
  DB_POOL_MAX: '1', DB_IDLE_TIMEOUT_MS: '10000', STARTUP_STAGGER_MS: '2000',
  SERVICE_BIND_HOST: '127.0.0.1', WEB_PORT: '3100', NEXT_DIST_DIR: '.next-local',
  API_URL: 'http://localhost:4000', GATEWAY_URL: 'http://localhost:4000',
  APP_URL: 'http://localhost:3100', WEB_ORIGIN: 'http://localhost:3100', NEXT_PUBLIC_API_URL: '',
  TOKEN_ISSUER: 'http://localhost:4001', JWKS_URL: 'http://localhost:4001/.well-known/jwks.json',
  ROOT_DOMAIN: '', NEXT_PUBLIC_ROOT_DOMAIN: '', COOKIE_DOMAIN: '', COOKIE_SECURE: 'false',
  COOKIE_SECRET: randomBytes(32).toString('hex'), SERVICE_TOKEN: randomBytes(32).toString('hex'),
  SMTP_URL: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', EMAIL_PROVIDER: '', ZEPTOMAIL_TOKEN: '',
  BILLING_TEST_MODE: 'true', REGISTER_PER_HOUR: '100',
};
// A deployment may override service locations; review services always stay local.
for (const key of Object.keys(env)) if (/^SERVICE_.*_URL$/.test(key) || ['IDENTITY_URL','TENANCY_URL','BILLING_URL','CATALOG_URL','NOTIFIER_URL'].includes(key)) delete env[key];
console.log('Local review: http://localhost:3100 · Supabase schemas ai_review_* (separate from deployed data)');
const child = spawn(process.execPath, ['scripts/dev.js', ...process.argv.slice(2)], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => { process.exitCode = code ?? 0; });
