import { claimOutbox, markOutboxSent } from '@nexus/db-kit';

/**
 * Outbox relay.
 *
 * Runs inside each service. Polls its own outbox table and publishes to NATS.
 * Because the outbox row was written in the same transaction as the business
 * change, an event can never exist without its cause, and a committed change
 * can never lose its event.
 */
export function startOutboxRelay({ db, bus, logger, intervalMs = 500, batch = 100 }) {
  let running = true;
  let timer;

  async function tick() {
    if (!running) return;
    try {
      const events = await claimOutbox(db, { batch });
      if (events.length) {
        const sent = [];
        for (const event of events) {
          try {
            await bus.publish(event);
            sent.push(event.id);
          } catch (error) {
            logger.error({ err: error, id: event.id, type: event.type }, 'relay publish failed');
          }
        }
        if (sent.length) {
          await markOutboxSent(db, sent);
          logger.debug({ count: sent.length }, 'outbox drained');
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'outbox relay tick failed');
    } finally {
      if (running) timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, intervalMs);
  logger.info('outbox relay started');

  return {
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}
