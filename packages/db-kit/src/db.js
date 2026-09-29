import pg from 'pg';
import { EventEmitter } from 'node:events';
import { UniqueViolation } from './errors.js';

/**
 * Fired after a transaction that wrote outbox rows commits, so this process's
 * relay publishes them straight away instead of on its next poll. Polling
 * stays as the fallback, just much less often.
 */
export const outboxSignal = new EventEmitter();
outboxSignal.setMaxListeners(50);

const { Pool, types } = pg;

// Return numerics as JS numbers where safe; keep bigint/decimal as strings.
types.setTypeParser(20, (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : v)); // int8
types.setTypeParser(1700, (v) => v); // numeric — money must never round-trip through float

/**
 * A `date` is a calendar date. It has no time and no time zone.
 *
 * By default pg parses it into a JS Date at LOCAL midnight, which
 * JSON.stringify then serialises via toISOString() — so 2026-09-28 leaves the
 * API as "2026-09-27T18:30:00.000Z" for anyone east of UTC, and every client
 * renders the wrong day. Keep it as the string Postgres actually sent.
 */
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(1182, (v) => v); // date[]

function translate(error) {
  if (error?.code === '23505') return new UniqueViolation(error.constraint, error);
  return error;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * TLS for hosted Postgres (Supabase, Neon, RDS…). `sslmode` in the URL is
 * stripped and replaced with explicit options: node-postgres would otherwise
 * verify against Node's CA store, which does not carry Supabase's root CA.
 * Set PG_SSL_CA (PEM contents) to verify the server certificate properly.
 */
function connectionOptions(url) {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');
  const hosted = !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const wantsTls = process.env.PG_SSL === 'false' ? false : mode ? mode !== 'disable' : hosted;
  if (!wantsTls) return { connectionString: parsed.toString() };
  const ca = process.env.PG_SSL_CA?.replace(/\\n/g, '\n');
  return {
    connectionString: parsed.toString(),
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
  };
}

/**
 * A pooled database handle for exactly one service.
 * Services never receive a handle to another service's database.
 *
 * With `schema` (or DB_SCHEMA), every service shares one physical database —
 * e.g. a single Supabase project — but owns exactly one schema in it. The
 * search_path is pinned per connection, so SQL stays unqualified and a service
 * still cannot see another service's tables without naming them outright.
 */
export function createDb({ url, max = 10, logger, appName = 'nexus', schema = process.env.DB_SCHEMA }) {
  if (!url) throw new Error('database url is required');
  if (schema && !SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name: ${schema}`);

  // A hosted database has a hard connection ceiling shared by every service.
  const cap = Number(process.env.DB_POOL_MAX);
  const size = Number.isInteger(cap) && cap > 0 ? Math.min(max, cap) : max;

  const pool = new Pool({
    ...connectionOptions(url),
    max: size,
    // Opening a connection to a hosted database costs a TLS handshake and a
    // SCRAM exchange — seconds, not milliseconds. Keep them.
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 300_000,
    keepAlive: true,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 30_000,
    application_name: appName,
    // The schema is a startup parameter, so it is in force before the first
    // query and nothing has to race it. (PG_SCHEMA_VIA_SET=true falls back to
    // a SET for poolers that drop startup options.)
    ...(schema && process.env.PG_SCHEMA_VIA_SET !== 'true' ? { options: `-c search_path="${schema}",public` } : {}),
  });

  pool.on('error', (err) => logger?.error({ err }, 'idle database client error'));
  // A pooler or the network can drop a connection while it is checked out
  // and idle between queries; unhandled, that 'error' event kills the process.
  // The pool discards the broken client when it is released.
  pool.on('connect', (client) => client.on('error', (err) => logger?.warn({ err }, 'database connection lost')));
  if (schema && process.env.PG_SCHEMA_VIA_SET === 'true') {
    pool.on('connect', (client) => client.query(`SET search_path TO "${schema}", public`).catch(() => {}));
  }

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
      if (tx.pending.length) outboxSignal.emit('written');
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
    schema: schema ?? null,
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
