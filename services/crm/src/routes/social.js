import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, resource, nullable,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { insertLead } from '../lib/leads.js';

const NETWORKS = ['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'whatsapp', 'google_business'];
const LIMITS = { x: 280, instagram: 2200, linkedin: 3000, facebook: 63206, youtube: 5000, whatsapp: 4096, google_business: 1500 };

/**
 * Social: plan posts on a shared calendar, get them approved, and be
 * reminded to publish at the right moment; keep comments, mentions and
 * messages in one inbox that the team replies from and turns into leads.
 *
 * Publishing straight to each network needs that network's API approval,
 * which is connected through Integrations; until then a post that falls due
 * reminds its author, who publishes and records the link here.
 */
export async function socialRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('social'), requirePermission(permission)];

  resource(app, {
    path: '/social/accounts', table: 'social_accounts', prefix: 'sacc', appSlug: 'social', label: 'Account',
    permissions: { view: 'social.posts.view', manage: 'social.accounts.manage' },
    fields: { network: v.enum(NETWORKS), handle: v.text(80, 1), display_name: nullable(v.text(120)), profile_url: nullable({ type: 'string', format: 'uri', maxLength: 500 }) },
    required: ['network', 'handle'], search: ['handle', 'display_name'], filters: { network: v.enum(NETWORKS) }, defaultSort: 'network ASC',
    uniqueMessage: 'That account is already added.',
  });

  async function checkAccounts(tx, orgId, ids = [], content = '') {
    if (!ids.length) return;
    const rows = await tx.rows(`SELECT id, network, handle FROM social_accounts WHERE org_id = $1 AND id = ANY($2)`, [orgId, ids]);
    if (rows.length !== new Set(ids).size) throw badRequest('Choose accounts from this workspace.');
    for (const acc of rows) {
      if (content.length > LIMITS[acc.network]) throw badRequest(`Too long for ${acc.network === 'x' ? 'X' : acc.network} (${content.length}/${LIMITS[acc.network]} characters).`);
    }
  }

  const posts = resource(app, {
    path: '/social/posts', table: 'social_posts', prefix: 'spost', appSlug: 'social', label: 'Post',
    permissions: { view: 'social.posts.view', create: 'social.posts.create', edit: 'social.posts.create', delete: 'social.posts.create' },
    fields: {
      content: v.text(63206, 1), account_ids: { type: 'array', items: v.id('sacc'), maxItems: 20 },
      media_urls: { type: 'array', items: { type: 'string', format: 'uri', maxLength: 1000 }, maxItems: 10 },
      scheduled_at: nullable(v.datetime), campaign: nullable(v.text(80)),
    },
    required: ['content'], search: ['content', 'campaign'], filters: { status: v.enum(['draft', 'pending_approval', 'scheduled', 'published', 'failed']) },
    defaultSort: 'scheduled_at DESC NULLS LAST, t.created_at DESC',
    hooks: {
      async beforeCreate(tx, data, request) { await checkAccounts(tx, request.ctx.orgId, data.account_ids, data.content); return data; },
      async beforeUpdate(tx, data, old, request) {
        if (old.status === 'published') throw badRequest('A published post cannot be changed.');
        await checkAccounts(tx, request.ctx.orgId, data.account_ids ?? old.account_ids, data.content ?? old.content);
        // Changed after approval? It goes back for another look.
        return old.status === 'scheduled' ? { ...data, status: 'pending_approval', approved_by: null } : data;
      },
    },
  });

  const postParams = { params: params({ id: v.id('spost') }) };
  const move = (path, permission, fn, schema) => app.post(`/social/posts/:id/${path}`, {
    preHandler: guard(permission), schema: { ...postParams, ...(schema ? { body: schema } : {}) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const p = await posts.load(tx, orgId, request.params.id, { lock: true });
      await fn(tx, p, request.body ?? {}, userId, request);
      return posts.load(tx, orgId, p.id);
    });
    return { data: row };
  });

  move('submit', 'social.posts.create', async (tx, p) => {
    if (p.status !== 'draft') throw badRequest(`This post is ${p.status.replace('_', ' ')}.`);
    if (!p.account_ids.length) throw badRequest('Choose where to post it.');
    await tx.query(`UPDATE social_posts SET status = 'pending_approval', updated_at = now() WHERE id = $1`, [p.id]);
  });
  move('approve', 'social.posts.publish', async (tx, p, b, userId) => {
    if (!['draft', 'pending_approval'].includes(p.status)) throw badRequest(`This post is ${p.status}.`);
    if (!p.account_ids.length) throw badRequest('Choose where to post it.');
    if (!p.scheduled_at) throw badRequest('Give it a date and time.');
    await tx.query(`UPDATE social_posts SET status = 'scheduled', approved_by = $2, reminded_at = NULL, updated_at = now() WHERE id = $1`, [p.id, userId]);
  });
  move('reject', 'social.posts.publish', async (tx, p) => {
    if (!['pending_approval', 'scheduled'].includes(p.status)) throw badRequest(`This post is ${p.status}.`);
    await tx.query(`UPDATE social_posts SET status = 'draft', approved_by = NULL, updated_at = now() WHERE id = $1`, [p.id]);
  });
  move('published', 'social.posts.publish', async (tx, p, b) => {
    if (p.status === 'published') throw badRequest('Already recorded as published.');
    await tx.query(`UPDATE social_posts SET status = 'published', published_at = now(), published_urls = $2, updated_at = now() WHERE id = $1`, [p.id, JSON.stringify(b.urls ?? {})]);
  }, body({ urls: { type: 'object', additionalProperties: { type: 'string', format: 'uri', maxLength: 500 } } }));

  app.get('/social/calendar', { preHandler: guard('social.posts.view'), schema: { querystring: query({ from: v.date, to: v.date }) } }, async (request) => {
    const from = request.query.from ?? new Date().toISOString().slice(0, 10);
    const to = request.query.to ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = await db.rows(
      `SELECT id, content, status, scheduled_at, published_at, account_ids, campaign FROM social_posts
        WHERE org_id = $1 AND COALESCE(published_at, scheduled_at) BETWEEN $2::date AND $3::date + 1 ORDER BY COALESCE(published_at, scheduled_at)`,
      [request.ctx.orgId, from, to],
    );
    const accounts = await db.rows(`SELECT id, network, handle FROM social_accounts WHERE org_id = $1`, [request.ctx.orgId]);
    return { data: { from, to, posts: rows, accounts } };
  });

  // Due posts remind their author (once) to publish.
  const timer = setInterval(async () => {
    try {
      const due = await db.rows(
        `UPDATE social_posts SET reminded_at = now() WHERE status = 'scheduled' AND reminded_at IS NULL AND scheduled_at <= now() + interval '5 minutes'
          RETURNING id, org_id, content, created_by, approved_by`,
      );
      for (const p of due) {
        await db.transaction(async (tx) => {
          tx.emit({ type: EVENTS.SOCIAL_POST_DUE, org_id: p.org_id, actor_id: null, data: { post_id: p.id, preview: p.content.slice(0, 120), created_by: p.created_by, approved_by: p.approved_by } });
        });
      }
    } catch (error) {
      app.log.error({ err: error }, 'social reminder failed');
    }
  }, 60_000);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));

  // ── inbox ─────────────────────────────────────────────────────────────────
  const inbox = resource(app, {
    path: '/social/inbox', table: 'social_inbox', prefix: 'sinb', appSlug: 'social', label: 'Message',
    permissions: { view: 'social.inbox.view', create: 'social.inbox.reply', edit: 'social.inbox.reply', delete: 'social.inbox.reply' },
    fields: {
      account_id: nullable(v.id('sacc')), kind: v.enum(['comment', 'mention', 'message', 'review']), author_name: v.text(120, 1), author_handle: nullable(v.text(80)),
      body: v.text(5000, 1), external_url: nullable({ type: 'string', format: 'uri', maxLength: 500 }), received_at: v.datetime,
    },
    required: ['author_name', 'body'], search: ['author_name', 'author_handle', 'body'],
    filters: { status: v.enum(['open', 'replied', 'closed']), kind: v.enum(['comment', 'mention', 'message', 'review']), account_id: v.id('sacc') },
    defaultSort: 'received_at DESC',
    columns: 't.*, a.network, a.handle AS account_handle',
    from: 'social_inbox t LEFT JOIN social_accounts a ON a.id = t.account_id',
  });

  const inboxParams = { params: params({ id: v.id('sinb') }) };
  app.post('/social/inbox/:id/reply', { preHandler: guard('social.inbox.reply'), schema: { ...inboxParams, body: body({ reply: v.text(5000, 1) }, ['reply']) } }, async (request) => {
    const { orgId, userId } = request.ctx;
    await inbox.load(db, orgId, request.params.id);
    await db.query(`UPDATE social_inbox SET status = 'replied', reply = $3, replied_by = $4, replied_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, request.params.id, request.body.reply.trim(), userId]);
    return { data: await inbox.load(db, orgId, request.params.id) };
  });
  app.post('/social/inbox/:id/close', { preHandler: guard('social.inbox.reply'), schema: inboxParams }, async (request) => {
    await db.query(`UPDATE social_inbox SET status = 'closed', updated_at = now() WHERE org_id = $1 AND id = $2`, [request.ctx.orgId, request.params.id]);
    return { data: await inbox.load(db, request.ctx.orgId, request.params.id) };
  });
  app.post('/social/inbox/:id/lead', { preHandler: [...guard('social.inbox.reply'), requirePermission('crm.leads.create')], schema: inboxParams }, async (request) => {
    const { orgId, userId } = request.ctx;
    if (!request.ctx.hasApp('crm')) throw badRequest('Turn on CRM to create leads.');
    const row = await db.transaction(async (tx) => {
      const m = await inbox.load(tx, orgId, request.params.id, { lock: true });
      if (m.lead_id) throw badRequest('Already a lead.');
      const [first, ...rest] = m.author_name.split(/\s+/);
      const lead = await insertLead(tx, { orgId, actorId: userId, fields: { first_name: first, last_name: rest.join(' ') || null, source: 'campaign', owner_user_id: userId, notes: `From ${m.network ?? 'social'} ${m.kind}${m.author_handle ? ` by @${m.author_handle}` : ''}:\n\n${m.body}` } });
      await tx.query(`UPDATE social_inbox SET lead_id = $2, updated_at = now() WHERE id = $1`, [m.id, lead.id]);
      return inbox.load(tx, orgId, m.id);
    });
    return { data: row };
  });
}
