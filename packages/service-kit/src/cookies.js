/**
 * Every value a request carries for one cookie name.
 *
 * A browser can hold two cookies with the same name: one for this exact host
 * (set while COOKIE_DOMAIN was empty) and one for the whole domain. It sends
 * both, oldest first, and the usual parser keeps only the first — often the
 * stale one. Callers try each value instead.
 */
export function cookieValues(request, name) {
  const header = request.headers?.cookie;
  if (!header) return [];
  const values = [];
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try { values.push(decodeURIComponent(raw)); } catch { values.push(raw); }
  }
  return values.filter(Boolean);
}
