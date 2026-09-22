import { APPS, APP_CATEGORIES } from '@nexus/contracts';

/**
 * GET /api/me/workspace — one call that boots the entire frontend.
 *
 * The sidebar, dashboard widgets, command palette and route guards are all
 * derived from this response. Nothing about a customer's app selection is
 * hardcoded in the UI.
 */
export async function workspaceRoutes(app) {
  const { authz, config } = app;

  app.get('/api/me/workspace', async (request) => {
    await app.authenticate(request);
    const { userId, orgId, epoch, email, name } = request.auth;

    if (!orgId) {
      return {
        data: {
          user: { id: userId, email, name },
          organization: null,
          needs_onboarding: true,
          apps: [],
          navigation: [],
          widgets: [],
          permissions: [],
        },
      };
    }

    const [authorization, entitlements] = await Promise.all([
      authz.permissions({ orgId, userId, epoch }),
      authz.entitlements(orgId),
    ]);

    const installed = await fetchInstalled(config, orgId, request.log);

    // An app appears only when it is entitled AND installed AND the user can
    // see at least one thing in it.
    const can = (permission) => authorization.isOwner || authorization.permissions.has(permission);

    const visible = APPS.filter(
      (definition) =>
        !definition.core &&
        entitlements.apps.has(definition.slug) &&
        installed.has(definition.slug) &&
        (definition.nav ?? []).some((item) => !item.permission || can(item.permission)),
    );

    const navigation = visible.map((definition) => ({
      slug: definition.slug,
      label: definition.name,
      icon: definition.icon,
      color: definition.color,
      category: definition.category,
      items: (definition.nav ?? [])
        .filter((item) => !item.permission || can(item.permission))
        .map(({ label, path, icon }) => ({ label, path, icon })),
    }));

    const widgets = visible
      .flatMap((definition) =>
        (definition.widgets ?? []).map((widget) => ({ ...widget, app: definition.slug })),
      )
      .filter((widget) => !widget.permission || can(widget.permission));

    return {
      data: {
        user: { id: userId, email, name },
        organization: { id: orgId },
        member: {
          id: authorization.memberId,
          roles: authorization.roles,
          is_owner: authorization.isOwner,
        },
        needs_onboarding: false,
        subscription: entitlements.subscription,
        apps: [...entitlements.apps].filter((slug) => slug !== 'core'),
        installed: [...installed],
        navigation,
        widgets,
        permissions: [...authorization.permissions],
        categories: APP_CATEGORIES,
      },
    };
  });
}

async function fetchInstalled(config, orgId, logger) {
  try {
    const response = await fetch(`${config.catalogUrl}/internal/orgs/${orgId}/apps`, {
      headers: { 'x-nexus-service-token': config.serviceToken },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    const payload = await response.json();
    return new Set((payload?.data ?? []).map((row) => row.app_slug));
  } catch (error) {
    logger.error({ err: error, orgId }, 'installed-app lookup failed');
    return new Set();
  }
}
