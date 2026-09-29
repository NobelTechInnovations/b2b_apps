import assert from 'node:assert/strict';
export const API = process.env.API_URL ?? 'http://localhost:4000';
export const password = 'correct-horse-battery-7';
export function session() {
  const jar = new Map();
  return {
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    async call(path, method = 'GET', body, retry = true) {
      const response = await fetch(`${API}/api${path}`, { method,
        headers: { 'content-type': 'application/json', cookie: this.cookie() },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(';')[0], i = pair.indexOf('=');
        jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
      const payload = await response.json();
      if (response.status === 401 && retry && !path.startsWith('/auth/')) {
        const refresh = await this.call('/auth/refresh', 'POST', {});
        if (refresh.status === 200) return this.call(path, method, body, false);
      }
      return { status: response.status, ...payload };
    },
  };
}
export function ok(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify(result));
  return result.data;
}
export async function workspace(apps, { plan = 'business', seats = 25, cycle = 'monthly' } = {}) {
  const client = session(), stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `regression-${stamp}@nexus.test`;
  ok(await client.call('/auth/register', 'POST', { email, password, name: 'Regression Owner' }), 201);
  ok(await client.call('/organizations', 'POST', { name: `Regression ${stamp}` }), 201);
  ok(await client.call('/auth/refresh', 'POST', {}));
  ok(await client.call('/subscriptions', 'POST', { plan, app_slugs: apps, seats, cycle }), 201);
  return { client, stamp, email };
}
export async function invite(owner, role, stamp) {
  const roles = ok(await owner.call('/roles'));
  const email = `${role}-${stamp}@nexus.test`, client = session();
  const invitation = ok(await owner.call('/invitations', 'POST', { email, role_ids: [roles.find(r => r.slug === role).id] }), 201);
  const token = new URL(invitation.invite_link).searchParams.get('token');
  ok(await client.call('/auth/register', 'POST', { email, password, name: 'Regression Colleague', invitation_token: token }), 201);
  return client;
}
