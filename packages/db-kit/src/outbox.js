import { id } from './id.js';

/**
 * Transactional outbox.
 *
 * Domain events are written to the service's own database in the SAME
 * transaction as the business change. A relay process then publishes them to
 * NATS. This removes the dual-write problem entirely: either the change and
 * its event both exist, or neither does.
 *
 * Every service's first migration creates this table.
 */
export async function writeOutbox(tx, events) {
  const list = Array.isArray(events) ? events : [events];
  if (!list.length) return [];

  const values = [];
  const rows = list.map((event, i) => {
    const base = i * 6;
    values.push(
      event.id ?? id('evt'),
      event.type,
      event.org_id ?? null,
      event.actor_id ?? null,
      JSON.stringify(event.data ?? {}),
      event.version ?? 1,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });

  const result = await tx.query(
    `INSERT INTO outbox (id, type, org_id, actor_id, data, version)
     VALUES ${rows.join(', ')}
     RETURNING id, type`,
    values,
  );
  return result.rows;
}

/** Relay: lock a batch of unpublished events without blocking writers. */
export async function claimOutbox(db, { batch = 100 } = {}) {
  const { rows } = await db.query(
    `UPDATE outbox SET claimed_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox
       WHERE published_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < now() - interval '30 seconds')
         AND attempts < 10
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, type, org_id, actor_id, data, version, created_at`,
    [batch],
  );
  return rows;
}

export async function markOutboxSent(db, ids) {
  if (!ids.length) return;
  await db.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [ids]);
}
