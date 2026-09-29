/**
 * Where the browser sends API calls.
 *
 * Same origin by default: next.config rewrites /api/* to the gateway, so auth
 * cookies are first-party on the apex domain and on every company subdomain,
 * and no CORS allow-list has to know each company's address. Set
 * NEXT_PUBLIC_API_URL only to call the gateway directly (it must then list
 * this origin in WEB_ORIGIN).
 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');

/** An absolute API address, for things configured outside the browser (devices). */
export function publicApiUrl(path) {
  const origin = API_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${origin}/api${path}`;
}
