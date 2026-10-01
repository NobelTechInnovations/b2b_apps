import { createRequire } from 'node:module';
import { loadEnvFile } from '../scripts/lib/services.js';

// pg is a dependency of db-kit, not of the repository root.
const pg = createRequire(new URL('../packages/db-kit/package.json', import.meta.url))('pg');

/**
 * Read one value the product only ever sends by email (a campaign
 * recipient's token, say). Tests only; never used by the services.
 */
export async function peek(sql, values = []) {
  const env = { ...loadEnvFile(new URL('../.env', import.meta.url).pathname), ...process.env };
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    // Tests name `nexus_<service>` schemas; follow a local DB_SCHEMA_PREFIX.
    const prefix = env.DB_SCHEMA_PREFIX;
    return await client.query(prefix ? sql.replaceAll('nexus_', prefix) : sql, values);
  } finally {
    await client.end();
  }
}
