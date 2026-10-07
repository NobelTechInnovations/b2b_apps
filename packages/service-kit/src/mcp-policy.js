/** Deployment URLs are trusted configuration. Request Host/Origin never expand
 * this allowlist. A ROOT_DOMAIN permits exactly one company subdomain. */
export function mcpRequestAllowed({ host, origin }, env = process.env) {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const origins = new Set(['http://localhost:3000', 'http://localhost:3100']);
  for (const value of (env.MCP_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) hosts.add(value.toLowerCase());
  for (const value of (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) origins.add(value);
  for (const configured of [env.APP_URL, env.API_URL, env.MCP_PUBLIC_URL, ...(env.WEB_ORIGIN ?? '').split(',')]) {
    if (!configured) continue;
    try {
      const url = new URL(configured.trim());
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      hosts.add(url.hostname); origins.add(url.origin);
    } catch { /* malformed configuration never opens access */ }
  }
  let root;
  try { if (env.ROOT_DOMAIN) root = new URL(`https://${env.ROOT_DOMAIN}`).hostname; } catch { /* fail closed */ }
  const companyHost = (name) => {
    if (!root) return false;
    if (name === root) return true;
    if (!name.endsWith(`.${root}`)) return false;
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name.slice(0, -root.length - 1));
  };
  if (host !== undefined) {
    if (!host || /[\s/@?#\\]/.test(host)) return false;
    let hostname;
    try { hostname = new URL(`http://${host}`).hostname; } catch { return false; }
    if (!hosts.has(hostname) && !companyHost(hostname)) return false;
  }
  if (origin) {
    let url;
    try { url = new URL(origin); } catch { return false; }
    if (url.origin !== origin) return false;
    if (!origins.has(origin) && !(url.protocol === 'https:' && !url.port && companyHost(url.hostname))) return false;
  }
  return true;
}
