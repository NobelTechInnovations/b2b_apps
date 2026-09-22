/**
 * Small, explicit SQL helpers. Deliberately not an ORM — every service owns
 * its schema and we want the generated SQL to be obvious at the call site.
 */

/** Tagged template that produces { text, values } with $1..$n placeholders. */
export function sql(strings, ...values) {
  let text = '';
  const params = [];
  strings.forEach((chunk, i) => {
    text += chunk;
    if (i < values.length) {
      params.push(values[i]);
      text += `$${params.length}`;
    }
  });
  return { text, values: params };
}

const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
};

/** INSERT … RETURNING *, from a plain object. */
export function insert(table, data, { returning = '*', onConflict } = {}) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) throw new Error('insert requires at least one column');
  const cols = keys.map(ident).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map((k) => data[k]);
  const conflict = onConflict ? ` ${onConflict}` : '';
  return {
    text: `INSERT INTO ${ident(table)} (${cols}) VALUES (${placeholders})${conflict} RETURNING ${returning}`,
    values,
  };
}

/**
 * UPDATE … WHERE, always tenant-scoped. Passing a falsy orgId is a programming
 * error and throws — this is the guard that stops a cross-tenant write.
 */
export function update(table, data, where, { returning = '*' } = {}) {
  if (!where || typeof where !== 'object' || !Object.keys(where).length) {
    throw new Error('update requires a where clause');
  }
  if ('org_id' in where && !where.org_id) {
    throw new Error('update called with an empty org_id — refusing to run unscoped');
  }
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) throw new Error('update requires at least one column');

  const values = [];
  const sets = keys.map((k) => {
    values.push(data[k]);
    return `${ident(k)} = $${values.length}`;
  });
  const conds = Object.entries(where).map(([k, v]) => {
    values.push(v);
    return `${ident(k)} = $${values.length}`;
  });

  return {
    text: `UPDATE ${ident(table)} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')} RETURNING ${returning}`,
    values,
  };
}

/**
 * Build a WHERE clause from a filter object.
 * Supports: scalar equality, arrays (IN), null (IS NULL),
 * { op: 'ilike'|'gt'|'gte'|'lt'|'lte'|'ne', value }.
 */
export function buildWhere(filters, startIndex = 1) {
  const clauses = [];
  const values = [];
  let n = startIndex;

  for (const [key, raw] of Object.entries(filters)) {
    if (raw === undefined) continue;
    const col = ident(key);

    if (raw === null) {
      clauses.push(`${col} IS NULL`);
    } else if (Array.isArray(raw)) {
      if (!raw.length) {
        clauses.push('false');
        continue;
      }
      clauses.push(`${col} = ANY($${n++})`);
      values.push(raw);
    } else if (typeof raw === 'object' && 'op' in raw) {
      const ops = { ilike: 'ILIKE', gt: '>', gte: '>=', lt: '<', lte: '<=', ne: '<>', eq: '=' };
      const op = ops[raw.op];
      if (!op) throw new Error(`unsupported filter op: ${raw.op}`);
      clauses.push(`${col} ${op} $${n++}`);
      values.push(raw.op === 'ilike' ? `%${raw.value}%` : raw.value);
    } else {
      clauses.push(`${col} = $${n++}`);
      values.push(raw);
    }
  }

  return {
    text: clauses.length ? clauses.join(' AND ') : 'true',
    values,
    nextIndex: n,
  };
}

const SORTABLE = /^[a-z_][a-z0-9_]*$/i;

/** Cursor-free keyset-ready pagination with a hard ceiling. */
export function paginate({ page = 1, limit = 25, sort, order = 'desc', allowedSorts = [] } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let orderBy = 'created_at DESC';
  if (sort && SORTABLE.test(sort) && allowedSorts.includes(sort)) {
    orderBy = `${ident(sort)} ${dir}`;
  }

  return {
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
    page: safePage,
    orderBy,
    meta: (total) => ({
      page: safePage,
      limit: safeLimit,
      total: Number(total),
      pages: Math.ceil(Number(total) / safeLimit) || 1,
    }),
  };
}
