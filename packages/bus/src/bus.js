import { connect, JSONCodec, AckPolicy, DeliverPolicy, RetentionPolicy } from 'nats';
import { envelope, isKnownEvent } from '@nexus/contracts/events';
import { createPgBus } from './pg-bus.js';

const codec = JSONCodec();
const STREAM = 'NEXUS';

/**
 * The platform event bus, on NATS JetStream.
 *
 * Producers publish through the transactional outbox (see @nexus/db-kit), so
 * `publish()` here is called by the relay, not by business code directly.
 * Consumers subscribe with a durable name and get at-least-once delivery;
 * handlers are expected to be idempotent on `event.id`.
 */
export async function createBus({ servers, name, logger = console, db }) {
  // BUS_DRIVER=postgres runs the bus on the platform database instead of NATS.
  // The service's own pool is reused when given; otherwise BUS_DATABASE_URL.
  if ((process.env.BUS_DRIVER ?? '').toLowerCase() === 'postgres') {
    const url = process.env.BUS_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!db && !url) throw new Error('BUS_DRIVER=postgres needs BUS_DATABASE_URL or a database handle');
    return createPgBus({ url, db, name, logger });
  }

  const nc = await connect({
    servers,
    name,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1_000,
  });

  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();

  await jsm.streams
    .add({
      name: STREAM,
      subjects: ['nexus.>'],
      retention: RetentionPolicy.Limits,
      max_age: 14 * 24 * 60 * 60 * 1_000_000_000, // 14 days, nanoseconds
      max_msgs_per_subject: 1_000_000,
      duplicate_window: 2 * 60 * 1_000_000_000, // 2 minutes
    })
    .catch(async (error) => {
      if (String(error).includes('already in use')) {
        await jsm.streams.update(STREAM, { subjects: ['nexus.>'] }).catch(() => {});
        return;
      }
      throw error;
    });

  (async () => {
    for await (const status of nc.status()) {
      logger.warn?.({ type: status.type, data: status.data }, 'nats status');
    }
  })().catch(() => {});

  // Consumer loops hold the event loop open, so they are tracked and stopped
  // on close — otherwise a service can never shut down cleanly.
  const consumers = new Set();

  return {
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

      const ack = await js.publish(`nexus.${event.type}`, codec.encode(payload), {
        msgID: payload.id,
      });
      logger.debug?.({ type: payload.type, seq: ack.seq }, 'event published');
      return ack;
    },

    /**
     * Durable subscription.
     *   subscribe('tasks', 'crm.deal.won', handler)
     *   subscribe('search', 'crm.*.*', handler)
     */
    async subscribe(consumerName, pattern, handler, { maxDeliver = 5, ackWait = 30, from = 'all' } = {}) {
      const durable = `${consumerName}--${pattern.replace(/[.*>]/g, '_')}`;

      await jsm.consumers
        .add(STREAM, {
          durable_name: durable,
          filter_subject: `nexus.${pattern}`,
          ack_policy: AckPolicy.Explicit,
          ...(from === 'new' ? { deliver_policy: DeliverPolicy.New } : {}),
          max_deliver: maxDeliver,
          ack_wait: ackWait * 1_000_000_000,
        })
        .catch((error) => {
          if (!String(error).includes('already exists')) throw error;
        });

      const consumer = await js.consumers.get(STREAM, durable);
      const messages = await consumer.consume();

      (async () => {
        for await (const msg of messages) {
          const event = codec.decode(msg.data);
          try {
            await handler(event, msg);
            msg.ack();
          } catch (error) {
            logger.error?.(
              { err: error, type: event.type, id: event.id, attempt: msg.info.redeliveryCount },
              'event handler failed',
            );
            // Backoff: 1s, 5s, 25s…  After max_deliver the message is dropped
            // to the dead-letter subject by the stream's advisory.
            msg.nak(Math.min(25_000, 1_000 * 5 ** (msg.info.redeliveryCount - 1)));
          }
        }
      })().catch((error) => logger.error?.({ err: error }, 'consumer loop stopped'));

      const handle = { durable, stop: () => messages.stop() };
      consumers.add(handle);
      return handle;
    },

    healthy: () => !nc.isClosed(),

    async close() {
      for (const consumer of consumers) {
        try {
          consumer.stop();
        } catch {
          // already stopped
        }
      }
      consumers.clear();
      await nc.drain().catch(() => {});
      await nc.close().catch(() => {});
    },
  };
}
