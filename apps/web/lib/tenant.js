/**
 * Company subdomains.
 *
 * With NEXT_PUBLIC_ROOT_DOMAIN set (e.g. `nexusapp.in`, or `lvh.me:3000`
 * locally), every company works at `<slug>.<root>` and the apex is the public
 * site plus sign-in. Without it, everything runs on one host as before.
 *
 * Works in the browser, in server components and in middleware alike.
 */
export const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? '').toLowerCase();

const RESERVED = new Set(['www', 'app', 'api', 'admin', 'static', 'assets', 'mail']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const subdomainsEnabled = () => Boolean(ROOT_DOMAIN);

/** The company slug a host belongs to, or null on the apex / when disabled. */
export function tenantFromHost(host) {
  if (!ROOT_DOMAIN || !host) return null;
  const clean = host.toLowerCase();
  if (clean === ROOT_DOMAIN || !clean.endsWith(`.${ROOT_DOMAIN}`)) return null;
  const sub = clean.slice(0, -(ROOT_DOMAIN.length + 1));
  if (sub.includes('.') || RESERVED.has(sub) || !SLUG.test(sub)) return null;
  return sub;
}

function protocol() {
  if (typeof window !== 'undefined') return window.location.protocol;
  return /localhost|lvh\.me|127\.0\.0\.1/.test(ROOT_DOMAIN) ? 'http:' : 'https:';
}

/** Absolute address of a page inside a company's workspace. */
export function tenantUrl(slug, path = '/dashboard') {
  if (!ROOT_DOMAIN || !slug) return path;
  return `${protocol()}//${slug}.${ROOT_DOMAIN}${path}`;
}

/** Absolute address of a page on the apex (sign-in, sign-up, marketing). */
export function apexUrl(path = '/') {
  if (!ROOT_DOMAIN) return path;
  return `${protocol()}//${ROOT_DOMAIN}${path}`;
}

/** A same-site relative path, or the fallback — never an open redirect. */
export function safePath(next, fallback = '/dashboard') {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : fallback;
}
