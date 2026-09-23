'use client';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor({ status, code, message, details, requestId }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** Field-keyed messages, for wiring validation errors back into a form. */
  get fieldErrors() {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries(
      this.details.filter((d) => d?.field).map((d) => [d.field, d.message]),
    );
  }
}

let refreshing = null;

async function refreshSession() {
  // Collapse concurrent 401s into a single refresh.
  refreshing ??= fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });

  return refreshing;
}

export async function api(
  path,
  { method = 'GET', body, query, signal, retry = true, headers, redirectOnUnauthorized = true } = {},
) {
  const url = new URL(`${API_URL}/api${path.startsWith('/') ? path : `/${path}`}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    credentials: 'include',
    signal,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // The access token is short-lived by design; renew it and carry on silently.
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      return api(path, { method, body, query, signal, retry: false, headers, redirectOnUnauthorized });
    }

    /*
     * Usually a dead session means "go and sign in". Not always: the join
     * page calls an authenticated endpoint precisely to find out whether the
     * invited person has an account yet, and a 401 there is the answer, not
     * an error. Bouncing it to /login would strand every new invitee.
     */
    if (
      redirectOnUnauthorized &&
      typeof window !== 'undefined' &&
      !window.location.pathname.startsWith('/login')
    ) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
  }

  if (response.status === 204) return null;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      code: payload?.error?.code ?? 'request_failed',
      message: payload?.error?.message ?? 'Something went wrong.',
      details: payload?.error?.details,
      requestId: payload?.error?.request_id,
    });
  }

  return payload;
}

api.get = (path, options) => api(path, { ...options, method: 'GET' });
api.post = (path, body, options) => api(path, { ...options, method: 'POST', body });
api.patch = (path, body, options) => api(path, { ...options, method: 'PATCH', body });
api.put = (path, body, options) => api(path, { ...options, method: 'PUT', body });
api.del = (path, options) => api(path, { ...options, method: 'DELETE' });
