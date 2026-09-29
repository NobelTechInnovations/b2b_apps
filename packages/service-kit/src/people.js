/**
 * Names for the people a screen needs to show — the agents a ticket can go
 * to, the interviewers on a panel, whoever filed an expense claim.
 *
 * Membership and permissions live in tenancy and names live in identity, so
 * an app service asks both over the internal network rather than copying
 * either. A lookup failure degrades to "no names", never to an error: a
 * list that shows "Unknown" beats a list that does not load.
 */
export function peopleDirectory({
  tenancyUrl, identityUrl = process.env.IDENTITY_URL ?? 'http://localhost:4001', serviceToken, ttlMs = 30_000,
}) {
  const cache = new Map();

  async function call(url, init = {}) {
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-nexus-service-token': serviceToken, ...init.headers },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json()).data ?? null;
  }

  async function lookup(ids) {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, 500);
    if (!unique.length) return new Map();
    const users = (await call(`${identityUrl}/internal/users/lookup`, { method: 'POST', body: JSON.stringify({ ids: unique }) })) ?? [];
    return new Map(users.map((u) => [u.id, { user_id: u.id, name: u.name, email: u.email, avatar_url: u.avatar_url ?? null }]));
  }

  /** Everyone active in the workspace who holds `permission` (owners always do). */
  async function withPermission(orgId, permission) {
    const key = `${orgId}:${permission}`;
    const hit = cache.get(key);
    if (hit && hit.at > Date.now() - ttlMs) return hit.people;
    const ids = (await call(`${tenancyUrl}/internal/orgs/${orgId}/members-with/${encodeURIComponent(permission)}`)) ?? [];
    const names = await lookup(ids);
    const people = ids.map((id) => names.get(id) ?? { user_id: id, name: 'Unknown member', email: null, avatar_url: null })
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    cache.set(key, { at: Date.now(), people });
    return people;
  }

  return { lookup, withPermission };
}
