import { cookies } from 'next/headers';

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Server Component fetch. Forwards the caller's cookies so the gateway sees the
 * same session the browser has, and never caches authenticated responses.
 */
export async function serverApi(path, { method = 'GET', body, query } = {}) {
  const jar = await cookies();
  const url = new URL(`${API_URL}/api${path.startsWith('/') ? path : `/${path}`}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }

  try {
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: jar.getAll().map((c) => `${c.name}=${c.value}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      return { data: null, error: payload?.error ?? { code: 'request_failed' }, status: response.status };
    }
    return { data: payload?.data ?? null, meta: payload?.meta, error: null, status: response.status };
  } catch (error) {
    // A service being down should degrade the page, not crash the render.
    return {
      data: null,
      error: { code: 'unreachable', message: error.message },
      status: 503,
    };
  }
}
