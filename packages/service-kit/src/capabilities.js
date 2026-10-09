/** Publish guarded operations for the assistant and MCP. Credentials and
 * public routes are deliberately absent; the original handler remains the
 * authority. Downloads and exports are published as `file` reads; uploads have
 * their own MCP tool, because they arrive as multipart rather than JSON. */

// Signed-in routes with no permission of their own (the caller's own
// notifications, access requests, workspace) belong to the platform apps.
const NAMESPACE_APP = { notifications: 'core', members: 'core', organizations: 'core', permissions: 'core', apps: 'catalog' };
const FILE_ROUTE = /\.(csv|pdf|xlsx|zip)$|\/(download|export)(\/|$)/i;

export function registerCapabilities(app, service) {
  const actions = new Map();
  app.addHook('onRoute', (route) => {
    const guards = [route.preHandler ?? []].flat();
    if (!guards.includes(app.loadContext) || route.config?.ai === false) return;
    const permissions = guards.map((guard) => guard.nexusPermission).filter(Boolean);
    const slug = permissions[0]?.split('.')[0] ?? NAMESPACE_APP[route.url.split('/')[1]];
    if (!slug) return;
    if (/\*|\/upload(\/|$)/i.test(route.url)) return;
    if (route.schema?.consumes?.some((type) => type !== 'application/json')) return;
    const file = FILE_ROUTE.test(route.url);
    for (const method of [route.method].flat()) {
      if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || (file && method !== 'GET')) continue;
      const action = {
        id: `${service}:${method}:${route.url}`, service, method, path: route.url,
        app: slug, permissions,
        description: route.schema?.description ?? `${method} ${route.url}${file ? ' (returns a file)' : ''}`,
        write: method !== 'GET',
        ...(file ? { file: true } : {}),
        input: {
          params: route.schema?.params ?? { type: 'object', additionalProperties: false },
          query: route.schema?.querystring ?? { type: 'object', additionalProperties: false },
          body: route.schema?.body ?? { type: 'object', additionalProperties: false },
        },
      };
      actions.set(action.id, action);
    }
  });
  app.get('/internal/ai-capabilities', { preHandler: app.verifyInternal }, async () => ({ data: [...actions.values()] }));
}
