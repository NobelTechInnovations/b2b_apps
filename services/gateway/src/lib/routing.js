import { APPS } from '@nexus/contracts';

/**
 * The routing table is derived, not written.
 *
 * Platform prefixes are fixed; every business app's prefix comes straight from
 * the registry, so shipping a new app needs no gateway change.
 */
const PLATFORM_ROUTES = [
  { prefix: 'auth',          service: 'identity', public: true },
  { prefix: 'account',       service: 'identity', requiresOrg: false },
  { prefix: 'organizations', service: 'tenancy',  requiresOrg: false },
  { prefix: 'members',       service: 'tenancy' },
  { prefix: 'roles',         service: 'tenancy' },
  { prefix: 'permissions',   service: 'tenancy' },
  { prefix: 'invitations',   service: 'tenancy',  requiresOrg: false },
  { prefix: 'teams',         service: 'tenancy' },
  { prefix: 'apps',          service: 'catalog' },
  { prefix: 'plans',         service: 'billing',  public: true },
  { prefix: 'subscriptions', service: 'billing',  requiresOrg: false },
  { prefix: 'files',         service: 'files' },
  { prefix: 'notifications', service: 'notifier' },
  { prefix: 'search',        service: 'search' },
  { prefix: 'audit',         service: 'audit' },
];

export function buildRoutingTable() {
  const table = new Map();

  for (const route of PLATFORM_ROUTES) {
    table.set(route.prefix, {
      service: route.service,
      app: null,
      public: route.public ?? false,
      requiresOrg: route.requiresOrg ?? true,
    });
  }

  for (const app of APPS) {
    if (app.core) continue;

    // An app slug that shadows a platform namespace would silently take over
    // its routing — which is how `subscriptions` once hijacked billing. Refuse
    // to start instead of serving a subtly wrong routing table.
    if (table.has(app.slug)) {
      throw new Error(
        `app slug "${app.slug}" collides with the reserved platform namespace ` +
          `"${app.slug}" (routed to ${table.get(app.slug).service}). Rename the app.`,
      );
    }

    table.set(app.slug, {
      service: app.service,
      app: app.slug,
      public: false,
      requiresOrg: true,
    });
  }

  return table;
}

/**
 * Service name → base URL.
 *
 * Platform services hold fixed ports. Business-app services are allocated
 * deterministically from the registry order, so shipping a new app never means
 * editing a routing table — and `SERVICE_<NAME>_URL` overrides any of them in
 * a real deployment.
 */
const PLATFORM_PORTS = {
  gateway: 4000,
  identity: 4001,
  tenancy: 4002,
  catalog: 4003,
  billing: 4004,
  files: 4005,
  notifier: 4006,
  search: 4007,
  audit: 4008,
};

const APP_PORT_BASE = 4010;

export function resolveUpstreams(env = process.env) {
  const upstreams = {};

  for (const [name, port] of Object.entries(PLATFORM_PORTS)) {
    upstreams[name] = `http://localhost:${port}`;
  }

  // Registry order is stable, so a service keeps its port across restarts.
  let offset = 0;
  for (const app of APPS) {
    if (upstreams[app.service]) continue;
    upstreams[app.service] = `http://localhost:${APP_PORT_BASE + offset}`;
    offset += 1;
  }

  for (const name of Object.keys(upstreams)) {
    const override = env[`SERVICE_${name.toUpperCase().replace(/-/g, '_')}_URL`];
    if (override) upstreams[name] = override;
  }

  return upstreams;
}
