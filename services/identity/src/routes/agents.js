import { createHash, randomBytes } from 'node:crypto';
import { id } from '@nexus/db-kit';
import { body, validate as v, badRequest, forbidden, notFound, unauthorized } from '@nexus/service-kit';
import { signAccessToken } from '../lib/tokens.js';
import { revokeSession } from '../lib/sessions.js';

export const hashAgentToken = (token) => createHash('sha256').update(token).digest('hex');
const fields = 'a.id, a.org_id, a.user_id, a.name, a.token_prefix, a.apps, a.allow_write, a.expires_at, a.last_used_at, a.created_at, COALESCE(a.revoked_at, s.revoked_at) AS revoked_at';

export async function agentRoutes(app) {
  const { db, config, tenancy, keys } = app;
  app.get('/account/agent-connections', { preHandler: app.loadContext }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { data: await db.rows(`SELECT ${fields} FROM agent_connections a JOIN sessions s ON s.id = a.session_id
      WHERE a.org_id = $1 AND (a.user_id = $2 OR $3) ORDER BY a.created_at DESC LIMIT 200`,
    [request.ctx.orgId, request.ctx.userId, request.ctx.isOwner]) };
  });
  app.post('/account/agent-connections', {
    preHandler: app.loadContext,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: body({ name: v.text(80, 2), apps: { type: 'array', minItems: 1, maxItems: 60, uniqueItems: true, items: v.text(40, 1) }, allow_write: v.bool, expires_in_days: { type: 'integer', minimum: 1, maximum: 90, default: 30 } }, ['name', 'apps']) },
  }, async (request, reply) => {
    const { orgId, userId, apps: accessible } = request.ctx;
    const { name, apps, allow_write = false, expires_in_days } = request.body;
    if (apps.some((slug) => !accessible.has(slug) && !['core', 'billing', 'catalog'].includes(slug))) throw forbidden('Choose only apps you can access in this company.');
    const token = `nx_mcp_${randomBytes(32).toString('base64url')}`;
    const connection = await db.transaction(async (tx) => {
      // Serialize the per-person connection limit, including concurrent creates.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agents:${orgId}:${userId}`]);
      const count = await tx.one('SELECT count(*)::int AS n FROM agent_connections WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()', [orgId, userId]);
      if (count.n >= 20) throw badRequest('Revoke an old connection before creating another (limit 20).');
      const sessionId = id('ses');
      const expires = new Date(Date.now() + expires_in_days * 86400000);
      // No refresh credential is issued for an agent session.
      await tx.query(`INSERT INTO sessions (id,user_id,family_id,refresh_hash,device_label,active_org_id,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [sessionId, userId, id('fam'), hashAgentToken(randomBytes(48)), `AI agent: ${name}`, orgId, expires]);
      return tx.one(`INSERT INTO agent_connections (id,org_id,user_id,session_id,name,token_hash,token_prefix,apps,allow_write,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,name,org_id,apps,allow_write,expires_at`,
      [id('agt'), orgId, userId, sessionId, name.trim(), hashAgentToken(token), token.slice(0, 15), apps, allow_write, expires]);
    });
    reply.header('cache-control', 'no-store');
    return reply.status(201).send({ data: { ...connection, token } });
  });
  app.delete('/account/agent-connections/:connectionId', { preHandler: app.loadContext }, async (request) => {
    await db.transaction(async (tx) => {
      const connection = await tx.one('SELECT * FROM agent_connections WHERE id = $1 AND org_id = $2 AND (user_id = $3 OR $4) FOR UPDATE',
        [request.params.connectionId, request.ctx.orgId, request.ctx.userId, request.ctx.isOwner]);
      if (!connection) throw notFound('Connection');
      await tx.query('UPDATE agent_connections SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [connection.id]);
      await revokeSession(tx, connection.session_id, 'agent_connection_revoked');
    });
    return { data: { revoked: true } };
  });
  app.post('/internal/agent-connections/exchange', {
    preHandler: app.verifyInternal,
    schema: { body: body({ token: { type: 'string', pattern: '^nx_mcp_[A-Za-z0-9_-]{43}$' } }, ['token']) },
  }, async (request, reply) => {
    const connection = await db.one(`SELECT a.*, u.email, u.name AS user_name FROM agent_connections a
      JOIN users u ON u.id = a.user_id JOIN sessions s ON s.id = a.session_id
      WHERE a.token_hash = $1 AND a.revoked_at IS NULL AND a.expires_at > now()
        AND u.status = 'active' AND s.revoked_at IS NULL AND s.expires_at > now()`, [hashAgentToken(request.body.token)]);
    if (!connection) throw unauthorized('This MCP connection is invalid, expired or revoked.');
    const membership = await tenancy.membership(connection.user_id, connection.org_id);
    if (!membership) throw forbidden('This user no longer has access to this company.');
    const accessToken = await signAccessToken({ keys, config: { ...config, accessTokenTtl: 60 },
      user: { id: connection.user_id, email: connection.email, name: connection.user_name }, membership, sessionId: connection.session_id });
    await db.query('UPDATE agent_connections SET last_used_at = now() WHERE id = $1', [connection.id]);
    reply.header('cache-control', 'no-store');
    return { data: { access_token: accessToken, connection: { id: connection.id, org_id: connection.org_id, user_id: connection.user_id, apps: connection.apps, allow_write: connection.allow_write } } };
  });
}
