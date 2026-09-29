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
 * Forward-only numbered SQL migrations, applied inside a transaction each.
 * A changed checksum on an applied migration is a hard failure — edit history
 * is never silently accepted.
 *
 * Concurrency: every step takes a TRANSACTION-scoped advisory lock (one per
 * schema) and re-reads what is applied inside it. That is safe behind a
 * transaction-mode connection pooler (Supabase's Supavisor on 6543), where a
 * session-level lock could be taken on one backend and "released" on another.
 */
export async function runMigrations({ db, dir, logger = console }) {
  const lockKey = `nexus-migrate:${db.schema ?? 'default'}`;
  const client = await db.pool.connect();

  async function locked(fn) {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      // Explicit, and transaction-local: correct however the pool treats sessions.
      if (db.schema) await client.query(`SET LOCAL search_path TO "${db.schema}", public`);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  try {
    if (db.schema) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${db.schema}"`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    await locked(() => client.query(TRACKING_TABLE));

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const body = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex').slice(0, 32);

      const started = Date.now();
      const applied = await locked(async () => {
        const existing = (await client.query(
          'SELECT checksum FROM schema_migrations WHERE version = $1',
          [version],
        )).rows[0];
        if (existing) {
          if (existing.checksum !== checksum) {
            throw new Error(
              `migration ${version} was modified after it was applied. ` +
                `Write a new migration instead of editing history.`,
            );
          }
          return false;
        }
        try {
          await client.query(body);
        } catch (error) {
          throw new Error(`migration ${version} failed: ${error.message}`, { cause: error });
        }
        await client.query(
          'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
          [version, checksum, Date.now() - started],
        );
        return true;
      });

      if (applied) {
        logger.info?.(`  ↑ ${version} (${Date.now() - started}ms)`);
        ran += 1;
      }
    }

    return { applied: ran, total: files.length };
  } finally {
    client.release();
  }
}
