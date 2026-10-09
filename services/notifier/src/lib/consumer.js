import { id } from '@nexus/db-kit';
import { RULES } from './rules.js';

/**
 * Events in, notifications out.
 *
 * Delivery is at-least-once, so a unique index on (event_id, user_id) makes
 * every insert idempotent: a redelivered event notifies nobody twice.
 */
export async function registerConsumer({ bus, db, tenancy, identity = null, sender = null, appUrl = '', logger }) {
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
        if (message.email !== false && sender && identity) await email(event, message, audience);
      }
    }
  }

  /**
   * The same news by email. Each (event, address) is sent once: a redelivered
   * event finds it already sent, unless the earlier try is waiting to retry.
   */
  async function email(event, message, audience) {
    const people = await identity.users([...audience, event.actor_id].filter(Boolean));
    const actor = event.actor_id ? people.get(event.actor_id)?.name ?? null : null;
    // Without a shaped email, the notice itself is the email.
    const content = typeof message.email === 'function'
      ? message.email(actor)
      : { subject: message.title, heading: message.title, lines: [message.body, actor && `From ${actor}.`] };
    let link = null;
    try { link = message.link ? new URL(message.link, appUrl).toString() : null; } catch { /* no APP_URL: send without a button */ }
    for (const userId of audience) {
      const to = people.get(userId)?.email;
      if (!to) continue;
      await sender.send({
        eventId: event.id, to, template: 'notification', orgId: event.org_id, occurredAt: event.occurred_at,
        data: { ...content, link },
      });
    }
  }

  // One at a time: dozens of subscriptions at once queue on a two-connection
  // pool, and at a cold start that queue can outlast the connect timeout.
  const subscriptions = [];
  for (const type of Object.keys(RULES)) subscriptions.push(await bus.subscribe('notifier', type, handle));
  return subscriptions;
}

/** Identity knows people's names and email addresses. */
export function createIdentityClient({ baseUrl, serviceToken }) {
  return {
    async users(ids) {
      if (!ids.length) return new Map();
      const response = await fetch(new URL('/internal/users/lookup', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nexus-service-token': serviceToken },
        body: JSON.stringify({ ids: [...new Set(ids)] }),
        signal: AbortSignal.timeout(5_000),
      });
      // Throwing redelivers the event; the in-app notice is already saved and is not repeated.
      if (!response.ok) throw new Error(`identity responded ${response.status}`);
      return new Map(((await response.json()).data ?? []).map((user) => [user.id, user]));
    },
  };
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
