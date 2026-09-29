import { id, paginate } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, notFound, badRequest, conflict,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

/**
 * The knowledge base. Readers see published articles; anyone who can edit
 * also sees drafts. Publishing is its own permission, so a team can write
 * freely while one person decides what goes live.
 */
export async function knowledgeRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('knowledge'), requirePermission(permission)];
  const articleParams = { params: params({ articleId: v.id('kba') }) };
  const categoryParams = { params: params({ categoryId: v.id('kbc') }) };

  const canSeeDrafts = (request) => request.ctx.can('knowledge.articles.edit') || request.ctx.can('knowledge.articles.publish');

  async function article(store, request, articleId, lock = false) {
    const row = await store.one(
      `SELECT a.*, c.name AS category_name FROM kb_articles a
         LEFT JOIN kb_categories c ON c.org_id = a.org_id AND c.id = a.category_id
        WHERE a.org_id = $1 AND a.id = $2${lock ? ' FOR UPDATE OF a' : ''}`,
      [request.ctx.orgId, articleId],
    );
    // A draft is invisible, not forbidden, to someone who may only read.
    if (!row || (row.status !== 'published' && !canSeeDrafts(request))) throw notFound('Article');
    return row;
  }

  async function assertCategory(orgId, categoryId) {
    if (!categoryId) return;
    const row = await db.one(`SELECT 1 FROM kb_categories WHERE org_id = $1 AND id = $2`, [orgId, categoryId]);
    if (!row) throw badRequest('Choose one of this workspace’s categories.');
  }

  // ══════════════════════════════════════════════════════════════ CATEGORIES
  app.get('/knowledge/categories', { preHandler: guard('knowledge.articles.view') }, async (request) => {
    const drafts = canSeeDrafts(request);
    return {
      data: await db.rows(
        `SELECT c.*, count(a.id)::int AS article_count FROM kb_categories c
           LEFT JOIN kb_articles a ON a.org_id = c.org_id AND a.category_id = c.id
                AND ($2::boolean OR a.status = 'published') AND a.status <> 'archived'
          WHERE c.org_id = $1 GROUP BY c.id ORDER BY c.position, c.name`,
        [request.ctx.orgId, drafts],
      ),
    };
  });

  app.post(
    '/knowledge/categories',
    { preHandler: guard('knowledge.spaces.manage'), schema: { body: body({ name: v.text(80, 1), description: v.text(500, 0), position: v.int(0, 1000) }, ['name']) } },
    async (request, reply) => {
      if (!request.body.name.trim()) throw badRequest('Name the category.');
      try {
        const row = await db.one(
          `INSERT INTO kb_categories (id, org_id, name, description, position) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [id('kbc'), request.ctx.orgId, request.body.name.trim(), request.body.description ?? '', request.body.position ?? 0],
        );
        return reply.status(201).send({ data: row });
      } catch (error) {
        if (error.name === 'UniqueViolation') throw conflict('A category with that name already exists.');
        throw error;
      }
    },
  );

  app.patch(
    '/knowledge/categories/:categoryId',
    { preHandler: guard('knowledge.spaces.manage'), schema: { ...categoryParams, body: body({ name: v.text(80, 1), description: v.text(500, 0), position: v.int(0, 1000) }) } },
    async (request) => {
      const old = await db.one(`SELECT * FROM kb_categories WHERE org_id = $1 AND id = $2`, [request.ctx.orgId, request.params.categoryId]);
      if (!old) throw notFound('Category');
      const next = { ...old, ...request.body };
      const row = await db.one(
        `UPDATE kb_categories SET name = $3, description = $4, position = $5 WHERE org_id = $1 AND id = $2 RETURNING *`,
        [old.org_id, old.id, next.name.trim(), next.description, next.position],
      );
      return { data: row };
    },
  );

  app.delete('/knowledge/categories/:categoryId', { preHandler: guard('knowledge.spaces.manage'), schema: categoryParams }, async (request) => {
    // Articles keep existing, uncategorised (ON DELETE SET NULL).
    const row = await db.one(`DELETE FROM kb_categories WHERE org_id = $1 AND id = $2 RETURNING id`, [request.ctx.orgId, request.params.categoryId]);
    if (!row) throw notFound('Category');
    return { data: { deleted: true } };
  });

  // ════════════════════════════════════════════════════════════════ ARTICLES
  app.get(
    '/knowledge/articles',
    {
      preHandler: guard('knowledge.articles.view'),
      schema: { querystring: query({ category_id: v.id('kbc'), status: v.enum(['draft', 'published', 'archived']) }) },
    },
    async (request) => {
      const { orgId } = request.ctx;
      const page = paginate({ ...request.query, allowedSorts: ['updated_at', 'title', 'views'] });
      const values = [orgId];
      const where = ['a.org_id = $1'];
      if (!canSeeDrafts(request)) where.push(`a.status = 'published'`);
      else if (request.query.status) { values.push(request.query.status); where.push(`a.status = $${values.length}`); }
      else where.push(`a.status <> 'archived'`);
      if (request.query.category_id) { values.push(request.query.category_id); where.push(`a.category_id = $${values.length}`); }

      let rank = '0';
      const q = request.query.q?.trim();
      if (q) {
        // Full-text on title (weighted) and body, with a prefix match so
        // "passp" finds "passport" while the reader is still typing.
        const terms = q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
        if (terms.length) {
          values.push(terms.map((t) => `${t}:*`).join(' & '));
          where.push(`a.search @@ to_tsquery('simple', $${values.length})`);
          rank = `ts_rank(a.search, to_tsquery('simple', $${values.length}))`;
        }
      }
      const clause = where.join(' AND ');
      const [rows, total] = await Promise.all([
        db.rows(
          `SELECT a.id, a.title, a.status, a.category_id, c.name AS category_name, a.tags, a.views,
                  a.author_id, a.updated_by, a.published_at, a.updated_at, a.created_at,
                  left(regexp_replace(a.body, '[#*_>\`\\[\\]()-]', '', 'g'), 220) AS excerpt
             FROM kb_articles a LEFT JOIN kb_categories c ON c.org_id = a.org_id AND c.id = a.category_id
            WHERE ${clause}
            ORDER BY ${q ? `${rank} DESC, ` : ''}a.${page.orderBy.startsWith('created_at') ? 'updated_at DESC' : page.orderBy}
            LIMIT ${page.limit} OFFSET ${page.offset}`,
          values,
        ),
        db.one(`SELECT count(*)::int AS n FROM kb_articles a WHERE ${clause}`, values),
      ]);
      return { data: rows, meta: page.meta(total.n) };
    },
  );

  app.get('/knowledge/articles/:articleId', { preHandler: guard('knowledge.articles.view'), schema: articleParams }, async (request) => {
    const row = await article(db, request, request.params.articleId);
    if (row.status === 'published') {
      await db.query(`UPDATE kb_articles SET views = views + 1 WHERE org_id = $1 AND id = $2`, [row.org_id, row.id]);
    }
    return { data: row };
  });

  const articleFields = {
    title: v.text(200, 1),
    body: { type: 'string', maxLength: 100_000 },
    category_id: nullable(v.id('kbc')),
    tags: { type: 'array', items: v.text(40), maxItems: 20 },
  };

  app.post(
    '/knowledge/articles',
    { preHandler: guard('knowledge.articles.create'), schema: { body: body(articleFields, ['title']) } },
    async (request, reply) => {
      const { orgId, userId } = request.ctx;
      if (!request.body.title.trim()) throw badRequest('Give the article a title.');
      await assertCategory(orgId, request.body.category_id);
      const row = await db.one(
        `INSERT INTO kb_articles (id, org_id, category_id, title, body, tags, author_id, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
        [id('kba'), orgId, request.body.category_id ?? null, request.body.title.trim(), request.body.body ?? '', request.body.tags ?? [], userId],
      );
      return reply.status(201).send({ data: row });
    },
  );

  app.patch(
    '/knowledge/articles/:articleId',
    { preHandler: guard('knowledge.articles.edit'), schema: { ...articleParams, body: body(articleFields) } },
    async (request) => {
      const { orgId, userId } = request.ctx;
      if (request.body.title !== undefined && !request.body.title.trim()) throw badRequest('Give the article a title.');
      if (request.body.category_id) await assertCategory(orgId, request.body.category_id);
      const row = await db.transaction(async (tx) => {
        const old = await article(tx, request, request.params.articleId, true);
        const next = { ...old, ...request.body };
        return tx.one(
          `UPDATE kb_articles SET title = $3, body = $4, category_id = $5, tags = $6, updated_by = $7, updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [orgId, old.id, next.title.trim(), next.body, next.category_id, next.tags, userId],
        );
      });
      return { data: row };
    },
  );

  app.post(
    '/knowledge/articles/:articleId/status',
    {
      preHandler: guard('knowledge.articles.publish'),
      schema: { ...articleParams, body: body({ status: v.enum(['draft', 'published', 'archived']) }, ['status']) },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const row = await db.transaction(async (tx) => {
        const old = await article(tx, request, request.params.articleId, true);
        if (request.body.status === 'published' && !old.body.trim()) throw badRequest('Write the article before publishing it.');
        const updated = await tx.one(
          `UPDATE kb_articles SET status = $3, updated_by = $4, updated_at = now(),
                  published_at = CASE WHEN $3 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [orgId, old.id, request.body.status, userId],
        );
        if (updated.status === 'published' && old.status !== 'published') {
          tx.emit({ type: EVENTS.ARTICLE_PUBLISHED, org_id: orgId, actor_id: userId, data: { article_id: updated.id, title: updated.title, author_id: updated.author_id } });
        }
        return updated;
      });
      return { data: row };
    },
  );

  app.delete('/knowledge/articles/:articleId', { preHandler: guard('knowledge.articles.delete'), schema: articleParams }, async (request) => {
    const row = await db.one(`DELETE FROM kb_articles WHERE org_id = $1 AND id = $2 RETURNING id`, [request.ctx.orgId, request.params.articleId]);
    if (!row) throw notFound('Article');
    return { data: { deleted: true } };
  });
}
