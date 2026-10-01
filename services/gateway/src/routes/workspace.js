import { APPS, APP_CATEGORIES, PORTAL_ROLES } from '@nexus/contracts';
import { memberApps } from '../lib/authz.js';

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

    // ...and this person has been given it.
    const activeApps = new Set([...entitlements.apps].filter((slug) => installed.has(slug)));
    const yourApps = memberApps(activeApps, authorization);

    const visible = APPS.filter(
      (definition) =>
        !definition.core &&
        yourApps.has(definition.slug) &&
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

    /*
     * A portal member holds only `self` permissions, so `navigation` above
     * resolves to nothing and they would otherwise land on an empty dashboard.
     * Saying so here — rather than inferring it in the browser from an empty
     * sidebar — lets the shell send them straight to their own screen.
     *
     * Someone who holds the employee role AND a working role is not a portal
     * user: they have a workspace to use, and the portal is just one more
     * place they can go.
     */
    // An employee added to task boards has a workspace to use (Tasks), so
    // they get the shell, with the portal one link away.
    const portalOnly =
      !authorization.isOwner &&
      authorization.roles.length > 0 &&
      authorization.roles.every((role) => PORTAL_ROLES.has(role)) &&
      navigation.length === 0;
    const selfService = [...authorization.permissions].some((permission) => permission.split('.')[1] === 'self')
      && (installed.has('hr') || installed.has('payroll'));

    return {
      data: {
        user: { id: userId, email, name },
        organization: { id: orgId },
        member: {
          id: authorization.memberId,
          roles: authorization.roles,
          is_owner: authorization.isOwner,
          portal_only: portalOnly,
          // null: every app. Otherwise only these were given to them.
          app_access: authorization.appAccess,
        },
        portal_only: portalOnly,
        self_service: selfService,
        needs_onboarding: false,
        subscription: entitlements.subscription,
        // The apps this person can use. The workspace's full set is
        // `workspace_apps`, for screens that manage who gets what.
        apps: [...entitlements.apps].filter((slug) => slug !== 'core' && (authorization.isOwner || !authorization.appAccess || yourApps.has(slug))),
        workspace_apps: [...entitlements.apps].filter((slug) => slug !== 'core'),
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
