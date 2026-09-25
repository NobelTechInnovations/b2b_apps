import { id } from '@nexus/db-kit';
import { RULES } from './rules.js';

/**
 * Events in, notifications out.
 *
 * Delivery is at-least-once, so a unique index on (event_id, user_id) makes
 * every insert idempotent: a redelivered event notifies nobody twice.
 */
export function registerConsumer({ bus, db, tenancy, logger }) {
  async function recipients(orgId, users) {
    if (Array.isArray(users)) return users;
    if (users?.permission) return tenancy.holders(orgId, users.permission);
    return [];
  }

  async function handle(event) {
    const rule = RULES[event.type];
    if (!rule || !event.org_id) return;

    for (const message of rule(event.data ?? {})) {
      const users = await recipients(event.org_id, message.users);

      // Never tell somebody about something they just did themselves.
      const audience = [...new Set(users)].filter((userId) => userId && userId !== event.actor_id);

      for (const userId of audience) {
        await db.query(
          `INSERT INTO notifications
             (id, org_id, user_id, kind, app, title, body, link, actor_id, event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (event_id, user_id) DO NOTHING`,
          [
            id('ntf'), event.org_id, userId, message.kind, message.app,
            message.title.slice(0, 300), message.body?.slice(0, 1000) ?? null,
            message.link ?? null, event.actor_id ?? null, event.id,
          ],
        );
      }

      if (audience.length) {
        logger?.debug({ type: event.type, recipients: audience.length }, 'notified');
      }
    }
  }

  return Promise.all(
    Object.keys(RULES).map((type) => bus.subscribe('notifier', type, handle)),
  );
}

/** Tenancy answers "who can do X here", cached briefly per workspace. */
export function createTenancyClient({ baseUrl, serviceToken, logger, ttlMs = 30_000 }) {
  const cache = new Map();

  return {
    async holders(orgId, permission) {
      const key = `${orgId}:${permission}`;
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;

      const response = await fetch(
        new URL(`/internal/orgs/${orgId}/members-with/${encodeURIComponent(permission)}`, baseUrl),
        { headers: { 'x-nexus-service-token': serviceToken }, signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) {
        // Throwing makes the bus redeliver, rather than dropping a notice that
        // somebody is waiting on an approval.
        logger?.warn({ status: response.status, permission }, 'could not resolve permission holders');
        throw new Error(`tenancy responded ${response.status}`);
      }

      const value = (await response.json()).data ?? [];
      cache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
  };
}
