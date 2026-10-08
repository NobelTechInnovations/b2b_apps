import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { id } from '../../packages/db-kit/src/id.js';
import { writeOutbox } from '../../packages/db-kit/src/outbox.js';
import { errorHandler, unauthorized } from '../../packages/service-kit/src/errors.js';
import { seedSystemRoles } from '../../services/tenancy/src/lib/permissions.js';
import { assertEmailChangeAccess } from '../../services/tenancy/src/lib/email-access.js';
import { emailChangeRoutes } from '../../services/identity/src/routes/email-change.js';
import { authRoutes } from '../../services/identity/src/routes/auth.js';
import { hashPassword, generateToken } from '../../services/identity/src/lib/password.js';
import { loadKeys } from '../../services/identity/src/lib/keys.js';

const require = createRequire(new URL('../../packages/service-kit/package.json', import.meta.url));
const Fastify = require('fastify');
export const password = 'Testing-a-secure-passphrase-42!';

/** Real PostgreSQL semantics, without touching .env or an external database. */
export async function emailChangeFixture({ rateLimit = false } = {}) {
  const pg = new PGlite();
  function adapter(client) {
    const query = async (sql, values = []) => {
      try {
        const result = await client.query(sql, values);
        return { ...result, rowCount: result.affectedRows ?? result.rows.length };
      } catch (error) {
        if (error.code === '23505') error.status = 409;
        throw error;
      }
    };
    return { query, rows: async (sql, values) => (await query(sql, values)).rows,
      one: async (sql, values) => (await query(sql, values)).rows[0] ?? null };
  }
  async function database(schema, service) {
    await pg.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    const dir = new URL(`../../services/${service}/migrations/`, import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await pg.exec(await readFile(new URL(file, dir), 'utf8'));
    }
    const transaction = (fn) => pg.transaction(async (client) => {
      await client.exec(`SET LOCAL search_path TO ${schema}`);
      const tx = adapter(client);
      const pending = [];
      tx.emit = (event) => pending.push(event);
      const result = await fn(tx);
      await writeOutbox(tx, pending);
      return result;
    });
    return { transaction, query: (sql, values) => transaction((tx) => tx.query(sql, values)),
      rows: (sql, values) => transaction((tx) => tx.rows(sql, values)),
      one: (sql, values) => transaction((tx) => tx.one(sql, values)) };
  }
  const db = await database('identity_test', 'identity');
  const tenancyDb = await database('tenancy_test', 'tenancy');
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(require('@fastify/cookie'));
  await app.register(require('@fastify/rate-limit'), { global: false, ...(rateLimit ? {} : { allowList: () => true }) });
  app.decorate('db', db);
  app.decorate('config', {
    appUrl: 'http://localhost:3100', tokenIssuer: 'http://identity.test', accessTokenTtl: 600,
    refreshTokenTtl: 86400, refreshCookiePath: '/api/auth', cookieSecure: false, maxFailedAttempts: 8, lockoutMinutes: 15,
  });
  app.decorate('keys', await loadKeys(db, { info() {} }));
  app.decorate('mailer', { send: async () => {} });
  app.decorate('tenancy', {
    authorizeEmailChange: (args) => assertEmailChangeAccess(tenancyDb, args),
    memberships: (userId) => tenancyDb.rows(`SELECT m.*, o.epoch, o.name AS org_name, o.slug AS org_slug
      FROM members m JOIN organizations o ON m.org_id = o.id WHERE m.user_id = $1 AND m.status = 'active'`, [userId]),
    membership: (userId, orgId) => tenancyDb.one(`SELECT m.*, o.epoch, o.name AS org_name, o.slug AS org_slug
      FROM members m JOIN organizations o ON m.org_id = o.id WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`, [userId, orgId]),
  });
  app.decorate('authenticate', async (req) => {
    const userId = req.headers['x-test-user'];
    if (!userId) throw unauthorized();
    req.auth = { userId, orgId: req.headers['x-test-org'] ?? null, sessionId: req.headers['x-test-session'] ?? null };
  });
  await app.register(emailChangeRoutes);
  await app.register(authRoutes);
  const passHash = await hashPassword(password);
  async function user(email) {
    return db.one(`INSERT INTO users (id, email, email_normalized, name, password_hash, email_verified_at)
      VALUES ($1,$2,$2,'Test Person',$3,now()) RETURNING *`, [id('usr'), email, passHash]);
  }
  async function organization(owner) {
    const orgId = id('org');
    await tenancyDb.query(`INSERT INTO organizations (id, name, slug, owner_user_id) VALUES ($1,'Email Test',$1,$2)`, [orgId, owner.id]);
    const roles = await tenancyDb.transaction((tx) => seedSystemRoles(tx, orgId));
    return { id: orgId, roles };
  }
  async function member(org, person, role = 'employee') {
    const memberId = id('mem');
    await tenancyDb.query(`INSERT INTO members (id, org_id, user_id) VALUES ($1,$2,$3)`, [memberId, org.id, person.id]);
    await tenancyDb.query(`INSERT INTO member_roles (org_id, member_id, role_id) VALUES ($1,$2,$3)`, [org.id, memberId, org.roles[role].id]);
    return memberId;
  }
  async function tokenFor(userId) {
    const events = await db.rows(`SELECT data FROM outbox WHERE type = 'notifier.notification.requested' AND data->>'template' = 'change_email' ORDER BY created_at DESC`);
    const pending = await db.one(`SELECT new_email FROM email_change_requests WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);
    return new URL(events.find((event) => event.data.to === pending?.new_email).data.payload.link).searchParams.get('token');
  }
  async function recoveryToken(person, purpose) {
    const token = generateToken();
    const record = await db.one(`INSERT INTO email_tokens (id, user_id, purpose, token_hash, email, expires_at)
      VALUES ($1,$2,$3,$4,$5,now() + interval '1 day') RETURNING *`, [id('emt'), person.id, purpose, token.hash, person.email]);
    return { ...token, record };
  }
  const call = async (url, { actor, org, payload, method = 'POST' } = {}) => app.inject({ method, url, payload,
    headers: { ...(actor ? { 'x-test-user': actor.id } : {}), ...(org ? { 'x-test-org': org.id } : {}) } });
  return { pg, app, db, tenancyDb, user, organization, member, tokenFor, recoveryToken, call,
    close: async () => { await app.close(); await pg.close(); } };
}
