import { createDb } from '@nexus/db-kit';
import { envelope, isKnownEvent } from '@nexus/contracts/events';
import { quietErrors } from './quiet.js';

/**
 * The platform event bus, on Postgres.
 *
 * Same contract as the NATS bus — publish(), durable subscribe() with
 * at-least-once delivery, healthy(), close() — so services do not know which
 * one they run on. It exists so a deployment needs nothing but a database:
 * one Supabase project and one API container, no broker to operate.
 *
 * Shape:
 *   nexus_bus.events     append-only log, deduplicated on the event id
 *   nexus_bus.consumers  one row per durable consumer: the last seq it handled
 *   nexus_bus.dead       events a consumer gave up on, for replay
 *
 * One poller per process reads the log once and hands each event to every
 * matching consumer. A consumer is worked under a short lease on its row, so
 * two replicas never process the same durable at once — and no database
 * connection is held while handlers run, which matters when a hosted
 * database allows each service only one or two.
 */
/**
 * Which schema holds the log. `nexus_bus` in every deployment; a local copy
 * sharing a hosted database with a live one sets DB_SCHEMA_PREFIX (`dev_`) so
 * the two never read each other's events.
 */
const BUS = process.env.BUS_SCHEMA || `${process.env.DB_SCHEMA_PREFIX || 'nexus_'}bus`;
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(BUS)) throw new Error(`invalid bus schema name: ${BUS}`);

const SCHEMA = `
  CREATE SCHEMA IF NOT EXISTS ${BUS};
  CREATE TABLE IF NOT EXISTS ${BUS}.events (
    seq        bigserial PRIMARY KEY,
    id         text NOT NULL UNIQUE,
    type       text NOT NULL,
    org_id     text,
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS events_created_idx ON ${BUS}.events (created_at);
  CREATE TABLE IF NOT EXISTS ${BUS}.consumers (
    durable    text PRIMARY KEY,
    last_seq   bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE ${BUS}.consumers ADD COLUMN IF NOT EXISTS leased_by text;
  ALTER TABLE ${BUS}.consumers ADD COLUMN IF NOT EXISTS leased_until timestamptz;
  CREATE TABLE IF NOT EXISTS ${BUS}.dead (
    id         bigserial PRIMARY KEY,
    durable    text NOT NULL,
    event_id   text NOT NULL,
    seq        bigint NOT NULL,
    error      text,
    attempts   integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );`;

// Rows younger than this are not read yet: a sequence value is taken before
// its insert commits, so a fresh gap may still fill in. A second of latency
// buys never skipping an event.
const SETTLE_MS = 1_000;
const RETENTION_DAYS = 14;

/** NATS-style subject matching: `*` is one token, `>` is the rest. */
export function subjectMatches(pattern, subject) {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '>') return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createPgBus({ url, db: shared, name, logger = console, pollMs = 1_000 }) {
  // Reuse the service's own pool when it has one: a hosted database has a hard
  // connection ceiling, and a second pool per service would double the draw.
  const db = shared ?? createDb({ url, max: 2, appName: `${name}-bus`, schema: null, logger });
  const ownsPool = !shared;

  // Every process runs the DDL; a transaction-scoped advisory lock keeps
  // concurrent boots from racing on CREATE TABLE IF NOT EXISTS (not itself
  // race-free), and stays correct behind a transaction-mode pooler.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('nexus-bus-schema'))`);
    await client.query(SCHEMA);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const consumers = new Map();
  const busy = new Set(); // durables with a run in flight
  let running = true;
  let timer = null;
  let lastOk = Date.now();
  let lastSweep = 0;
  const fail = quietErrors(logger);

  const holder = `${name}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  const LEASE_MS = 60_000;

  /**
   * Hand `events` (already read, in order) to one consumer, under a lease.
   * The offset is re-read with the lease, so a second replica — or a stale
   * in-memory offset — can never make an event run twice.
   */
  async function runConsumer(consumer, events, upTo) {
    const lease = await db.one(
      `UPDATE ${BUS}.consumers
          SET leased_by = $2, leased_until = now() + ($3 || ' milliseconds')::interval
        WHERE durable = $1 AND (leased_until IS NULL OR leased_until < now() OR leased_by = $2)
        RETURNING last_seq`,
      [consumer.durable, holder, LEASE_MS],
    );
    // Another replica is working this consumer right now.
    if (!lease) return;

    let last = Number(lease.last_seq);
    try {
      for (const event of events) {
        if (!consumer.running) break;
        if (Number(event.seq) <= last) continue;
        if (subjectMatches(consumer.pattern, event.type)) await deliver(consumer, event);
        last = Number(event.seq);
      }
      if (consumer.running) last = Math.max(last, upTo);
    } finally {
      await db.query(
        `UPDATE ${BUS}.consumers SET last_seq = GREATEST(last_seq, $3), leased_by = NULL, leased_until = NULL,
                updated_at = now()
          WHERE durable = $1 AND leased_by = $2`,
        [consumer.durable, holder, last],
      );
      consumer.seq = Math.max(consumer.seq, last);
    }
  }

  async function deliver(consumer, event) {
    const message = { info: { redeliveryCount: 1 } };
    for (let attempt = 1; attempt <= consumer.maxDeliver; attempt += 1) {
      message.info.redeliveryCount = attempt;
      try {
        await consumer.handler(event.payload, message);
        return;
      } catch (error) {
        logger.error?.(
          { err: error, type: event.type, id: event.id, attempt, consumer: consumer.durable },
          'event handler failed',
        );
        if (attempt === consumer.maxDeliver) {
          await db.query(
            `INSERT INTO ${BUS}.dead (durable, event_id, seq, error, attempts) VALUES ($1, $2, $3, $4, $5)`,
            [consumer.durable, event.id, event.seq, String(error?.message ?? error).slice(0, 2000), attempt],
          );
          return;
        }
        // 250ms, 1s, 4s… capped — the consumer waits, it does not skip ahead.
        await sleep(Math.min(8_000, 250 * 4 ** (attempt - 1)));
      }
    }
  }

  /**
   * One read per tick for the whole process: the events past the furthest-
   * behind consumer. An idle bus costs a single indexed query. Consumers with
   * nothing relevant in the batch just have their offset moved on, in bulk.
   */
  async function tick() {
    if (!running) return;
    try {
      // A consumer still working through an earlier batch sits this tick out;
      // everyone else carries on.
      const list = [...consumers.values()].filter((c) => c.running && !busy.has(c.durable));
      if (list.length) {
        const from = Math.min(...list.map((c) => c.seq));
        const events = await db.rows(
          `SELECT seq, id, type, payload FROM ${BUS}.events
            WHERE seq > $1 AND created_at < now() - ($2 || ' milliseconds')::interval
            ORDER BY seq LIMIT 500`,
          [from, SETTLE_MS],
        );
        if (events.length) {
          const upTo = Number(events[events.length - 1].seq);
          const skipped = [];
          const due = [];
          for (const consumer of list) {
            const relevant = events.some((e) => Number(e.seq) > consumer.seq && subjectMatches(consumer.pattern, e.type));
            if (relevant) due.push(consumer);
            else if (consumer.seq < upTo) skipped.push(consumer);
          }
          // Consumers are independent durables, so each runs on its own and the
          // poll loop never waits for one: a handler backing off on a failing
          // email must not hold every in-app notification in the process
          // behind it. Order within a consumer is unchanged, and `busy` keeps
          // a consumer from being started again while it is still running.
          for (const consumer of due) {
            busy.add(consumer.durable);
            runConsumer(consumer, events, upTo)
              .catch((error) => fail(error, 'event bus consumer failed'))
              .finally(() => busy.delete(consumer.durable));
          }
          if (skipped.length) {
            await db.query(
              `UPDATE ${BUS}.consumers c SET last_seq = $2, updated_at = now()
                WHERE c.durable = ANY($1) AND c.last_seq < $2
                  AND (c.leased_until IS NULL OR c.leased_until < now())`,
              [skipped.map((c) => c.durable), upTo],
            );
            for (const consumer of skipped) consumer.seq = upTo;
          }
        }
      }
      if (Date.now() - lastSweep > 3_600_000) {
        lastSweep = Date.now();
        await db.query(
          `DELETE FROM ${BUS}.events WHERE created_at < now() - ($1 || ' days')::interval`,
          [RETENTION_DAYS],
        );
      }
      lastOk = Date.now();
    } catch (error) {
      fail(error, 'event bus poll failed');
    } finally {
      if (running) timer = setTimeout(tick, pollMs);
    }
  }

  timer = setTimeout(tick, pollMs);

  return {
    driver: 'postgres',

    /** Publish one domain event. `event.id` doubles as the dedupe key. */
    async publish(event) {
      if (!isKnownEvent(event.type)) {
        throw new Error(`refusing to publish unknown event type "${event.type}"`);
      }
      const payload = envelope({
        id: event.id,
        type: event.type,
        orgId: event.org_id,
        actorId: event.actor_id,
        data: typeof event.data === 'string' ? JSON.parse(event.data) : event.data,
        version: event.version,
        occurredAt: event.created_at ?? event.occurred_at,
      });
      await db.query(
        `INSERT INTO ${BUS}.events (id, type, org_id, payload) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [payload.id, payload.type, payload.org_id ?? null, JSON.stringify(payload)],
      );
      return { seq: null };
    },

    /**
     * Durable subscription. A new durable starts from the oldest retained
     * event, as a JetStream durable with DeliverPolicy.All does — or, with
     * `from: 'new'`, from now on (for side effects such as email, where
     * replaying two weeks of history would be a disaster).
     */
    async subscribe(consumerName, pattern, handler, { maxDeliver = 5, from = 'all' } = {}) {
      const durable = `${consumerName}--${pattern.replace(/[.*>]/g, '_')}`;
      const row = await db.one(
        `INSERT INTO ${BUS}.consumers (durable, last_seq)
         VALUES ($1, CASE WHEN $2 THEN (SELECT COALESCE(max(seq), 0) FROM ${BUS}.events) ELSE 0 END)
         ON CONFLICT (durable) DO UPDATE SET durable = EXCLUDED.durable
         RETURNING last_seq`,
        [durable, from === 'new'],
      );
      const consumer = { durable, pattern, handler, maxDeliver, running: true, seq: Number(row.last_seq) };
      consumers.set(durable, consumer);
      return {
        durable,
        stop: () => {
          consumer.running = false;
          consumers.delete(durable);
        },
      };
    },

    healthy: () => running && Date.now() - lastOk < 30_000,

    async close() {
      running = false;
      clearTimeout(timer);
      for (const consumer of consumers.values()) consumer.running = false;
      consumers.clear();
      if (ownsPool) await db.close().catch(() => {});
    },
  };
}
