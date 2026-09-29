import { id as newId, paginate } from '@nexus/db-kit';
import { validate as v, body, params, query } from './validate.js';
import { requireApp, requirePermission } from './guards.js';
import { badRequest, conflict, notFound } from './errors.js';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name) => {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier in resource spec: ${name}`);
  return name;
};

/**
 * The CRUD half of an app entity, generated from a spec.
 *
 * Most of what the business apps store — vendors, warehouses, equipment,
 * courses, clauses — is a record with fields, a list with search and filters,
 * and an edit form. Writing those five endpoints by hand twenty-seven times is
 * how inconsistencies creep in (one list forgets its org filter, another
 * trusts a client-sent total). This writes them once:
 *
 *   - every query is scoped to the caller's workspace;
 *   - every route checks the app is enabled and the permission is held;
 *   - bodies are validated against the field schemas (unknown keys refused);
 *   - identifiers in SQL come only from the spec, never from the request.
 *
 * Domain behaviour (receiving stock, posting a journal) is written by hand
 * next to it; `load()` is returned for exactly that.
 *
 * Tables follow one convention: `id text PRIMARY KEY, org_id text NOT NULL`,
 * plus `created_by`, `created_at`, `updated_at`.
 */
export function resource(app, spec) {
  const {
    path, table, prefix, appSlug,
    permissions,
    fields = {}, required = [], json = [],
    search = [], filters = {}, sorts = [], defaultSort = 'created_at DESC',
    columns = 't.*', from, shape = (row) => row,
    label = 'Record', uniqueMessage,
    hooks = {},
    readOnly = false,
  } = spec;

  const { db } = app;
  const T = ident(table);
  const source = from ?? `${T} t`;
  const perm = {
    view: permissions.view,
    create: permissions.create ?? permissions.manage,
    edit: permissions.edit ?? permissions.manage ?? permissions.create,
    delete: permissions.delete ?? permissions.manage ?? permissions.edit,
  };
  for (const key of [...Object.keys(fields), ...search, ...Object.keys(filters), ...sorts]) ident(key);

  const guard = (permission) => [app.loadContext, requireApp(appSlug), requirePermission(permission)];
  const idParams = { params: params({ id: v.id(prefix) }) };
  const encode = (data) => {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      out[key] = json.includes(key) && value !== null ? JSON.stringify(value) : value;
    }
    return out;
  };
  const trimmed = (data) => Object.fromEntries(Object.entries(data).map(([k, value]) => [k, typeof value === 'string' ? value.trim() : value]));

  async function load(store, orgId, recordId, { lock = false } = {}) {
    const row = await store.one(
      `SELECT ${columns} FROM ${source} WHERE t.org_id = $1 AND t.id = $2${lock ? ' FOR UPDATE OF t' : ''}`,
      [orgId, recordId],
    );
    if (!row) throw notFound(label);
    return row;
  }

  async function list(request, { where: extraWhere = [], values: extraValues = [] } = {}) {
    if (hooks.beforeList) await hooks.beforeList(request);
    const qs = request.query;
    const page = paginate({ ...qs, allowedSorts: sorts });
    const values = [request.ctx.orgId, ...extraValues];
    const where = ['t.org_id = $1', ...extraWhere];
    for (const key of Object.keys(filters)) {
      if (qs[key] === undefined || qs[key] === '') continue;
      values.push(qs[key]);
      where.push(`t.${key} = $${values.length}`);
    }
    if (qs.q?.trim() && search.length) {
      values.push(`%${qs.q.trim()}%`);
      where.push(`(${search.map((c) => `t.${c}::text ILIKE $${values.length}`).join(' OR ')})`);
    }
    const clause = where.join(' AND ');
    const order = qs.sort && sorts.includes(qs.sort) ? `t.${page.orderBy}` : defaultSort.split(',').map((part) => (part.includes('.') ? part : `t.${part.trim()}`)).join(', ');
    const [rows, total] = await Promise.all([
      db.rows(`SELECT ${columns} FROM ${source} WHERE ${clause} ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}`, values),
      db.one(`SELECT count(*)::int AS n FROM ${source} WHERE ${clause}`, values),
    ]);
    return { data: rows.map(shape), meta: page.meta(total.n) };
  }

  const translateUnique = (error) => {
    if (error.name === 'UniqueViolation') throw conflict(uniqueMessage ?? `That ${label.toLowerCase()} already exists.`);
    throw error;
  };

  app.get(path, { preHandler: guard(perm.view), schema: { querystring: query(filters) } }, (request) => list(request));

  app.get(`${path}/:id`, { preHandler: guard(perm.view), schema: idParams }, async (request) => {
    const row = await load(db, request.ctx.orgId, request.params.id);
    return { data: shape(hooks.detail ? await hooks.detail(db, row, request) : row) };
  });

  if (!readOnly) {
    app.post(path, { preHandler: guard(perm.create), schema: { body: body(fields, required) } }, async (request, reply) => {
      const { orgId, userId } = request.ctx;
      const data = trimmed(request.body);
      for (const key of required) {
        if (typeof data[key] === 'string' && !data[key]) throw badRequest(`${key.replace(/_/g, ' ')} is required.`);
      }
      try {
        const row = await db.transaction(async (tx) => {
          const prepared = hooks.beforeCreate ? await hooks.beforeCreate(tx, data, request) : data;
          const record = encode({ id: newId(prefix), org_id: orgId, created_by: userId, ...prepared });
          const keys = Object.keys(record);
          const created = await tx.one(
            `INSERT INTO ${T} (${keys.map(ident).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
            keys.map((k) => record[k]),
          );
          const full = await load(tx, orgId, created.id);
          if (hooks.afterCreate) await hooks.afterCreate(tx, full, request);
          return full;
        });
        return reply.status(201).send({ data: shape(row) });
      } catch (error) {
        return translateUnique(error);
      }
    });

    app.patch(`${path}/:id`, { preHandler: guard(perm.edit), schema: { ...idParams, body: body(fields) } }, async (request) => {
      const { orgId } = request.ctx;
      const data = trimmed(request.body);
      for (const key of required) {
        if (key in data && (data[key] === null || data[key] === '')) throw badRequest(`${key.replace(/_/g, ' ')} is required.`);
      }
      try {
        const row = await db.transaction(async (tx) => {
          const old = await load(tx, orgId, request.params.id, { lock: true });
          const prepared = hooks.beforeUpdate ? await hooks.beforeUpdate(tx, data, old, request) : data;
          const changes = encode(prepared);
          const keys = Object.keys(changes);
          if (keys.length) {
            await tx.query(
              `UPDATE ${T} SET ${keys.map((k, i) => `${ident(k)} = $${i + 3}`).join(', ')}, updated_at = now() WHERE org_id = $1 AND id = $2`,
              [orgId, old.id, ...keys.map((k) => changes[k])],
            );
          }
          const updated = await load(tx, orgId, old.id);
          if (hooks.afterUpdate) await hooks.afterUpdate(tx, updated, old, request);
          return updated;
        });
        return { data: shape(row) };
      } catch (error) {
        return translateUnique(error);
      }
    });

    app.delete(`${path}/:id`, { preHandler: guard(perm.delete), schema: idParams }, async (request) => {
      const { orgId } = request.ctx;
      await db.transaction(async (tx) => {
        const old = await load(tx, orgId, request.params.id, { lock: true });
        if (hooks.beforeDelete) await hooks.beforeDelete(tx, old, request);
        await tx.query(`DELETE FROM ${T} WHERE org_id = $1 AND id = $2`, [orgId, old.id]);
      });
      return { data: { deleted: true } };
    });
  }

  return { load, list, guard };
}

/** A nullable version of a schema, for optional fields the client may clear. */
export const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

/** Money in: a number or a decimal string. Money out is always a string. */
export const amount = { anyOf: [{ type: 'number', minimum: 0, maximum: 1e11 }, v.money] };
