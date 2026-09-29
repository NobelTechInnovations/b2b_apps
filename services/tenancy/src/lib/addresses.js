import { randomInt } from 'node:crypto';

/**
 * Every workspace gets its own address: <company>-<digits>.<root domain>.
 *
 * The digits are what make two "Acme"s distinct without either of them having
 * to think of something clever, and they make an address hard to guess from
 * the company name alone.
 */
export const RESERVED = new Set([
  'app', 'api', 'www', 'admin', 'settings', 'billing', 'support', 'help', 'mail',
  'docs', 'status', 'auth', 'login', 'signup', 'nexus', 'internal', 'static', 'assets',
]);

export const slugify = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '') || 'workspace';

/** A fresh `<name>-<4 digits>` candidate; widened to 6 digits on repeated collisions. */
export function candidateSlug(name, attempt = 0) {
  const digits = attempt < 20 ? 4 : 6;
  const suffix = String(randomInt(10 ** (digits - 1), 10 ** digits));
  return `${slugify(name)}-${suffix}`;
}

/** The web address of a workspace, or the apex when subdomains are off. */
export function workspaceUrl(config, slug, path = '/') {
  if (!config.rootDomain || !slug) return `${config.appUrl}${path}`;
  const protocol = new URL(config.appUrl).protocol;
  return `${protocol}//${slug}.${config.rootDomain}${path}`;
}
