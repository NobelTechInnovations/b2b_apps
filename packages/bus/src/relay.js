import { claimOutbox, markOutboxSent, outboxSignal } from '@nexus/db-kit';

/**
 * Outbox relay.
 *
 * Runs inside each service. Polls its own outbox table and publishes to NATS.
 * Because the outbox row was written in the same transaction as the business
 * change, an event can never exist without its cause, and a committed change
 * can never lose its event.
 */
export function startOutboxRelay({ db, bus, logger, intervalMs = Number(process.env.OUTBOX_POLL_MS) || 3_000, batch = 100 }) {
  let running = true;
  let timer;
  let busy = false;
  let again = false;

  async function tick() {
    if (!running) return;
    if (busy) { again = true; return; }
    busy = true;
    clearTimeout(timer);
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
      busy = false;
      if (running) timer = setTimeout(tick, again ? 0 : intervalMs);
      again = false;
    }
  }

  // A committed write wakes the relay at once; the poll only catches the rest
  // (rows written outside a transaction, or by a process that crashed).
  const wake = () => { if (running) setImmediate(tick); };
  outboxSignal.on('written', wake);

  timer = setTimeout(tick, intervalMs);
  logger.info('outbox relay started');

  return {
    stop() {
      running = false;
      outboxSignal.off('written', wake);
      clearTimeout(timer);
    },
  };
}
