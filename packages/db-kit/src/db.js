import pg from 'pg';
import { UniqueViolation } from './errors.js';

const { Pool, types } = pg;

// Return numerics as JS numbers where safe; keep bigint/decimal as strings.
types.setTypeParser(20, (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : v)); // int8
types.setTypeParser(1700, (v) => v); // numeric — money must never round-trip through float

function translate(error) {
  if (error?.code === '23505') return new UniqueViolation(error.constraint, error);
  return error;
}

/**
 * A pooled database handle for exactly one service.
 * Services never receive a handle to another service's database.
 */
export function createDb({ url, max = 10, logger, appName = 'nexus' }) {
  if (!url) throw new Error('database url is required');

  const pool = new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: appName,
  });

  pool.on('error', (err) => logger?.error({ err }, 'idle database client error'));

  async function query(text, params = []) {
    const started = process.hrtime.bigint();
    try {
      const result = await pool.query(text, params);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (ms > 200) logger?.warn({ ms, sql: text.slice(0, 160) }, 'slow query');
      return result;
    } catch (error) {
      logger?.error({ err: error, sql: text.slice(0, 300) }, 'query failed');
      throw translate(error);
    }
  }

  const rows = async (text, params) => (await query(text, params)).rows;
  const one = async (text, params) => (await query(text, params)).rows[0] ?? null;

  /**
   * Run a unit of work in a transaction. The callback receives a client-bound
   * `tx` with the same shape as `db`, plus `emit()` for the outbox — so a
   * domain event can never be published without its business change
   * committing, and vice versa.
   */
  async function transaction(fn, { orgId } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Row-level-security anchor: policies read this for tenant scoping.
      if (orgId) await client.query('SELECT set_config($1, $2, true)', ['app.org_id', orgId]);

      const tx = {
        query: async (text, params = []) => {
          try {
            return await client.query(text, params);
          } catch (error) {
            throw translate(error);
          }
        },
      };
      tx.rows = async (text, params) => (await tx.query(text, params)).rows;
      tx.one = async (text, params) => (await tx.query(text, params)).rows[0] ?? null;
      tx.pending = [];
      tx.emit = (event) => tx.pending.push(event);

      const result = await fn(tx);

      if (tx.pending.length) {
        const { writeOutbox } = await import('./outbox.js');
        await writeOutbox(tx, tx.pending);
      }

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    query,
    rows,
    one,
    transaction,
    async healthy() {
      const res = await pool.query('SELECT 1 AS ok');
      return res.rows[0]?.ok === 1;
    },
    async close() {
      await pool.end();
    },
  };
}
