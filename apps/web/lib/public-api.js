const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/**
 * Server-side fetch for the public pages (forms, careers). Deliberately sends
 * no cookies: these endpoints need no session, and a visitor's session has no
 * business travelling with them.
 */
export async function publicApi(path) {
  try {
    const response = await fetch(`${API_URL}/api${path}`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    return { data: response.ok ? payload?.data ?? null : null, status: response.status };
  } catch {
    return { data: null, status: 503 };
  }
}
