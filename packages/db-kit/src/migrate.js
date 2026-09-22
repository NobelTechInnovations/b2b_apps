import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  )`;

/**
 * Forward-only numbered SQL migrations, applied inside a transaction each,
 * guarded by an advisory lock so concurrent deploys cannot race.
 * A changed checksum on an applied migration is a hard failure — edit history
 * is never silently accepted.
 */
export async function runMigrations({ db, dir, logger = console }) {
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(4815162342)');
    await client.query(TRACKING_TABLE);

    const applied = new Map(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [
        r.version,
        r.checksum,
      ]),
    );

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const body = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex').slice(0, 32);

      if (applied.has(version)) {
        if (applied.get(version) !== checksum) {
          throw new Error(
            `migration ${version} was modified after it was applied. ` +
              `Write a new migration instead of editing history.`,
          );
        }
        continue;
      }

      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(body);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
          [version, checksum, Date.now() - started],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${version} failed: ${error.message}`, { cause: error });
      }
      logger.info?.(`  ↑ ${version} (${Date.now() - started}ms)`);
      ran += 1;
    }

    return { applied: ran, total: files.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock(4815162342)').catch(() => {});
    client.release();
  }
}
