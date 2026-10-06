/** Publish only guarded JSON operations. Credentials, public routes and binary
 * transfers are deliberately absent. The original handler remains the authority. */
export function registerCapabilities(app, service) {
  const actions = new Map();
  app.addHook('onRoute', (route) => {
    const guards = [route.preHandler ?? []].flat();
    const permissions = guards.map((guard) => guard.nexusPermission).filter(Boolean);
    if (!guards.includes(app.loadContext) || !permissions.length || route.config?.ai === false) return;
    if (/\*|\.(csv|pdf|xlsx|zip)|\/(download|upload|export|import)(\/|$)/i.test(route.url)) return;
    if (route.schema?.consumes?.some((type) => type !== 'application/json')) return;
    for (const method of [route.method].flat()) {
      if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) continue;
      const action = {
        id: `${service}:${method}:${route.url}`, service, method, path: route.url,
        app: permissions[0].split('.')[0], permissions,
        description: route.schema?.description ?? `${method} ${route.url}`,
        write: method !== 'GET',
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
