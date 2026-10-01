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
  // Looking up an invitation must work before you have an account — that is
  // the whole point of being invited. Its own prefix, because the gateway's
  // policy is per namespace and the rest of `invitations` needs a session.
  { prefix: 'invite',        service: 'tenancy',  public: true },
  // A company subdomain's sign-in page names the company before sign-in.
  { prefix: 'workspace-lookup', service: 'tenancy', public: true },
  // Published forms and the careers page are for people with no account. The
  // owning services accept only a public token or an open job there.
  { prefix: 'public-forms',  service: 'crm',      public: true },
  { prefix: 'careers',       service: 'hr',       public: true },
  // The public storefront: published stores only, priced from the catalogue.
  { prefix: 'store',         service: 'erp',      public: true },
  // A customer's quote page, a partner's portal, and email open/click/
  // unsubscribe links. Each accepts only its own unguessable token.
  { prefix: 'quote-view',    service: 'crm',      public: true },
  { prefix: 'partner-portal', service: 'crm',     public: true },
  { prefix: 'mkt',           service: 'crm',      public: true },
  // Leads pushed in by other systems (a source's own link) and Meta's lead
  // webhook (checked against the app secret's signature).
  { prefix: 'lead-hooks',    service: 'crm',      public: true },
  { prefix: 'teams',         service: 'tenancy' },
  { prefix: 'apps',          service: 'catalog' },
  { prefix: 'plans',         service: 'billing',  public: true },
  { prefix: 'subscriptions', service: 'billing',  requiresOrg: false },
  // Payment providers call in with no user; billing verifies their signature.
  { prefix: 'billing-webhooks', service: 'billing', public: true },
  { prefix: 'files',         service: 'files' },
  { prefix: 'notifications', service: 'notifier' },
  { prefix: 'search',        service: 'search' },
  { prefix: 'audit',         service: 'audit' },
  // Attendance terminals have no user and no token. They authenticate with a
  // device key the HR service issued, which it verifies itself — the gateway
  // only proves that the request came through it.
  { prefix: 'device-sync',   service: 'hr',       public: true },
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

/**
 * Services that are built and deployed keep a fixed port. Deriving them from
 * registry order meant that moving one app to another service (Knowledge into
 * Helpdesk, say) silently shifted every port after it.
 */
export const SERVICE_PORTS = {
  crm: 4010,
  helpdesk: 4019,
  invoicing: 4022,
  hr: 4030,
  payroll: 4031,
  tasks: 4034,
  documents: 4036,
  erp: 4040,
};

export function resolveUpstreams(env = process.env) {
  const upstreams = {};

  for (const [name, port] of Object.entries({ ...PLATFORM_PORTS, ...SERVICE_PORTS })) {
    upstreams[name] = `http://localhost:${port}`;
  }

  // Everything not yet built still gets a stable, unused port from registry order.
  const taken = new Set(Object.values({ ...PLATFORM_PORTS, ...SERVICE_PORTS }));
  let port = APP_PORT_BASE;
  for (const app of APPS) {
    if (upstreams[app.service]) continue;
    while (taken.has(port)) port += 1;
    upstreams[app.service] = `http://localhost:${port}`;
    taken.add(port);
  }

  for (const name of Object.keys(upstreams)) {
    const override = env[`SERVICE_${name.toUpperCase().replace(/-/g, '_')}_URL`];
    if (override) upstreams[name] = override;
  }

  return upstreams;
}
