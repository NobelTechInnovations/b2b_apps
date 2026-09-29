import { id } from '@nexus/db-kit';
import { requirePermission, body, validate as v, badRequest, conflict, notFound, forbidden } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { seedSystemRoles, bumpEpoch } from '../lib/permissions.js';
import { RESERVED, candidateSlug, workspaceUrl } from '../lib/addresses.js';

export async function organizationRoutes(app) {
  const { db, config } = app;

  /**
   * `<company>-<digits>`, always — never the bare name, so nobody has to
   * compete for "acme" and an address is not trivially guessable. The unique
   * index is the final word; this just avoids needless collisions.
   */
  async function uniqueSlug(name) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = candidateSlug(name, attempt);
      if (RESERVED.has(candidate)) continue;
      const taken = await db.one(`SELECT 1 FROM organizations WHERE slug = $1`, [candidate]);
      if (!taken) return candidate;
    }
    throw conflict('Could not derive a unique workspace address.');
  }

  // ═══════════════════════════════════════════ CREATE WORKSPACE (onboarding)
  app.post(
    '/organizations',
    {
      preHandler: app.authenticate,
      schema: {
        body: body(
          {
            name: v.text(120, 2),
            slug: v.slug,
            industry: v.text(60),
            size_band: v.enum(['1-10', '11-50', '51-200', '201-500', '500+']),
            country: { type: 'string', minLength: 2, maxLength: 2 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            timezone: v.text(64),
          },
          ['name'],
        ),
      },
    },
    async (request, reply) => {
      const { userId, email, name: userName } = request.auth;

      // A person can own several workspaces, but not an unbounded number.
      const owned = await db.one(
        `SELECT count(*)::int AS n FROM organizations WHERE owner_user_id = $1 AND status = 'active'`,
        [userId],
      );
      if (owned.n >= 10) {
        throw forbidden('You have reached the limit of 10 workspaces. Contact support to raise it.');
      }

      const slug = await uniqueSlug(request.body.slug || request.body.name);

      const result = await db.transaction(async (tx) => {
        const org = await tx.one(
          `INSERT INTO organizations
             (id, name, slug, industry, size_band, country, currency, timezone, owner_user_id)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6,'IN'), COALESCE($7,'INR'), COALESCE($8,'Asia/Kolkata'), $9)
           RETURNING *`,
          [
            id('org'),
            request.body.name.trim(),
            slug,
            request.body.industry ?? null,
            request.body.size_band ?? null,
            request.body.country,
            request.body.currency,
            request.body.timezone,
            userId,
          ],
        );

        const roles = await seedSystemRoles(tx, org.id);

        const member = await tx.one(
          `INSERT INTO members (id, org_id, user_id, status, title)
           VALUES ($1, $2, $3, 'active', 'Owner') RETURNING *`,
          [id('mem'), org.id, userId],
        );

        await tx.query(
          `INSERT INTO member_roles (org_id, member_id, role_id, granted_by)
           VALUES ($1, $2, $3, $4)`,
          [org.id, member.id, roles.owner.id, userId],
        );

        tx.emit({
          type: EVENTS.ORG_CREATED,
          org_id: org.id,
          actor_id: userId,
          data: {
            org_id: org.id,
            name: org.name,
            slug: org.slug,
            industry: org.industry,
            size_band: org.size_band,
            currency: org.currency,
            owner_user_id: userId,
            owner_email: email,
            owner_name: userName,
          },
        });

        return { org, member, roles };
      });

      return reply.status(201).send({
        data: {
          organization: { ...serialize(result.org), url: workspaceUrl(config, result.org.slug, '/dashboard') },
          member: { id: result.member.id, roles: ['owner'] },
        },
      });
    },
  );

  /**
   * Which company a subdomain belongs to — public, because the sign-in page on
   * that subdomain needs it before anybody has signed in. It says only what
   * the address itself already implies: the name and logo.
   */
  app.get(
    '/workspace-lookup/:slug',
    { schema: { params: { type: 'object', properties: { slug: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' } }, required: ['slug'] } } },
    async (request) => {
      const org = await db.one(
        `SELECT id, name, slug, logo_url FROM organizations WHERE slug = $1 AND status = 'active'`,
        [request.params.slug],
      );
      if (!org) throw notFound('Workspace');
      return { data: org };
    },
  );

  // ══════════════════════════════════════════════════════ READ / UPDATE ORG
  app.get('/organizations/current', { preHandler: app.loadContext }, async (request) => {
    const org = await db.one(`SELECT * FROM organizations WHERE id = $1`, [request.ctx.orgId]);
    if (!org) throw notFound('Workspace');

    const counts = await db.one(
      `SELECT
         (SELECT count(*)::int FROM members WHERE org_id = $1 AND status = 'active')  AS members,
         (SELECT count(*)::int FROM members WHERE org_id = $1 AND status = 'invited') AS invited,
         (SELECT count(*)::int FROM teams   WHERE org_id = $1)                        AS teams`,
      [org.id],
    );

    return { data: { ...serialize(org), counts } };
  });

  app.patch(
    '/organizations/current',
    {
      preHandler: [app.loadContext, requirePermission('core.settings.manage')],
      schema: {
        body: body({
          name: v.text(120, 2),
          legal_name: v.text(160),
          logo_url: v.text(500),
          website: v.text(200),
          industry: v.text(60),
          size_band: v.enum(['1-10', '11-50', '51-200', '201-500', '500+']),
          timezone: v.text(64),
          fiscal_year_start: v.int(1, 12),
          tax_id: v.text(40),
          address: { type: 'object', additionalProperties: true },
          settings: { type: 'object', additionalProperties: true },
        }),
      },
    },
    async (request) => {
      const allowed = [
        'name', 'legal_name', 'logo_url', 'website', 'industry', 'size_band',
        'timezone', 'fiscal_year_start', 'tax_id', 'address', 'settings',
      ];
      const fields = allowed.filter((f) => request.body[f] !== undefined);
      if (!fields.length) throw badRequest('Nothing to update.');

      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const values = fields.map((f) =>
        ['address', 'settings'].includes(f) ? JSON.stringify(request.body[f]) : request.body[f],
      );

      const org = await db.transaction(async (tx) => {
        const updated = await tx.one(
          `UPDATE organizations SET ${sets} WHERE id = $1 RETURNING *`,
          [request.ctx.orgId, ...values],
        );
        tx.emit({
          type: EVENTS.ORG_UPDATED,
          org_id: updated.id,
          actor_id: request.ctx.userId,
          data: { org_id: updated.id, changed: fields },
        });
        return updated;
      });

      return { data: serialize(org) };
    },
  );

  // ════════════════════════════════════════════════════════ TRANSFER / LEAVE
  app.post(
    '/organizations/current/transfer-ownership',
    {
      preHandler: [app.loadContext, requirePermission('core.settings.manage')],
      schema: { body: body({ member_id: v.id('mem') }, ['member_id']) },
    },
    async (request) => {
      if (!request.ctx.isOwner) throw forbidden('Only the owner can transfer ownership.');

      const target = await db.one(
        `SELECT * FROM members WHERE id = $1 AND org_id = $2 AND status = 'active'`,
        [request.body.member_id, request.ctx.orgId],
      );
      if (!target) throw notFound('Member');

      await db.transaction(async (tx) => {
        const ownerRole = await tx.one(
          `SELECT id FROM roles WHERE org_id = $1 AND slug = 'owner'`,
          [request.ctx.orgId],
        );
        const adminRole = await tx.one(
          `SELECT id FROM roles WHERE org_id = $1 AND slug = 'admin'`,
          [request.ctx.orgId],
        );

        await tx.query(
          `INSERT INTO member_roles (org_id, member_id, role_id, granted_by)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [request.ctx.orgId, target.id, ownerRole.id, request.ctx.userId],
        );

        // The outgoing owner keeps admin rights, not owner rights.
        await tx.query(
          `DELETE FROM member_roles WHERE org_id = $1 AND member_id = $2 AND role_id = $3`,
          [request.ctx.orgId, request.ctx.memberId, ownerRole.id],
        );
        await tx.query(
          `INSERT INTO member_roles (org_id, member_id, role_id, granted_by)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [request.ctx.orgId, request.ctx.memberId, adminRole.id, request.ctx.userId],
        );

        await tx.query(`UPDATE organizations SET owner_user_id = $2 WHERE id = $1`, [
          request.ctx.orgId,
          target.user_id,
        ]);

        await bumpEpoch(tx, request.ctx.orgId);

        tx.emit({
          type: EVENTS.MEMBER_ROLE_CHANGED,
          org_id: request.ctx.orgId,
          actor_id: request.ctx.userId,
          data: { member_id: target.id, user_id: target.user_id, change: 'ownership_transferred' },
        });
      });

      return { data: { transferred: true } };
    },
  );
}

function serialize(org) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    legal_name: org.legal_name,
    logo_url: org.logo_url,
    website: org.website,
    industry: org.industry,
    size_band: org.size_band,
    country: org.country,
    currency: org.currency,
    timezone: org.timezone,
    fiscal_year_start: org.fiscal_year_start,
    tax_id: org.tax_id,
    address: org.address,
    settings: org.settings,
    status: org.status,
    created_at: org.created_at,
  };
}
