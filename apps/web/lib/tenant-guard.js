import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { subdomainsEnabled, tenantUrl } from './tenant';

/**
 * Put the signed-in person in the workspace this address belongs to.
 *
 *   apex, has a workspace       → redirect to <their slug>.<root>/same/page
 *   subdomain = active workspace → carry on
 *   subdomain = another of theirs → switch the session to it (client-side)
 *   subdomain they don't belong to → refuse, and point them home
 *
 * The token is what actually scopes every API call; this only keeps the
 * address bar and the session telling the same story.
 */
export async function resolveTenant(me) {
  if (!subdomainsEnabled()) return { ok: true };
  const h = await headers();
  const tenant = h.get('x-nexus-tenant');
  const page = h.get('x-nexus-page') ?? '/dashboard';
  const organizations = me?.organizations ?? [];
  const active = organizations.find((o) => o.id === me?.active_org_id);

  if (!tenant) {
    if (active) redirect(tenantUrl(active.slug, page));
    return { ok: true };
  }
  if (active?.slug === tenant) return { ok: true };

  const target = organizations.find((o) => o.slug === tenant);
  if (target) return { switchTo: { id: target.id, name: target.name } };
  return {
    noAccess: {
      tenant,
      home: active ? tenantUrl(active.slug, '/dashboard') : null,
      homeName: active?.name ?? null,
    },
  };
}
