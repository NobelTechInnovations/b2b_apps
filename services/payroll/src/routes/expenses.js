import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, notFound, badRequest, forbidden, conflict, peopleDirectory,
} from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { toPaise, toRupees } from '../lib/money.js';

const DEFAULT_CATEGORIES = [
  { name: 'Travel & conveyance', limit: null, receipt: true },
  { name: 'Food & meals', limit: 3000, receipt: true },
  { name: 'Internet & phone', limit: 1500, receipt: true },
  { name: 'Office supplies', limit: null, receipt: true },
  { name: 'Client & student meetings', limit: null, receipt: true },
  { name: 'Other', limit: null, receipt: false },
];
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const amount = { anyOf: [{ type: 'number', exclusiveMinimum: 0, maximum: 10_000_000 }, v.money] };

/**
 * Expense claims.
 *
 * Everyone sees and edits their own claims. Seeing anyone else's takes the
 * approve or reimburse permission — "view" alone never shows a colleague's
 * spending. Nobody decides their own claim.
 *
 *   draft → submitted → approved → reimbursed
 *                    ↘ rejected → (edited) → submitted
 */
export async function expenseRoutes(app) {
  const { db, config } = app;
  const people = peopleDirectory(config);
  // Whose claim is it — names come from identity, one batched lookup per page.
  const withNames = async (rows) => {
    const names = await people.lookup(rows.map((r) => r.user_id));
    return rows.map((r) => ({ ...r, claimant_name: names.get(r.user_id)?.name ?? null }));
  };
  const guard = (permission) => [app.loadContext, requireApp('expenses'), requirePermission(permission)];
  const claimParams = { params: params({ claimId: v.id('exp') }) };
  const reviewer = (request) => request.ctx.can('expenses.claims.approve') || request.ctx.can('expenses.claims.reimburse');

  async function categories(store, orgId) {
    const existing = await store.one(`SELECT 1 FROM expense_categories WHERE org_id = $1 LIMIT 1`, [orgId]);
    if (!existing) {
      for (const c of DEFAULT_CATEGORIES) {
        await store.query(
          `INSERT INTO expense_categories (id, org_id, name, monthly_limit_paise, requires_receipt)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [id('excat'), orgId, c.name, c.limit ? c.limit * 100 : null, c.receipt],
        );
      }
    }
    return store.rows(`SELECT * FROM expense_categories WHERE org_id = $1 ORDER BY active DESC, name`, [orgId]);
  }

  const shapeCategory = (c) => ({ ...c, monthly_limit: c.monthly_limit_paise ? toRupees(Number(c.monthly_limit_paise)) : null });
  const shapeLine = (l) => ({ ...l, amount: toRupees(Number(l.amount_paise)) });
  const shapeClaim = (c) => ({ ...c, total: toRupees(Number(c.total_paise)) });

  /** The claim, if the caller may see it: their own, or any if they review. */
  async function claim(store, request, claimId, lock = false) {
    const row = await store.one(
      `SELECT * FROM expense_claims WHERE org_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
      [request.ctx.orgId, claimId],
    );
    if (!row || (row.user_id !== request.ctx.userId && !reviewer(request))) throw notFound('Claim');
    return row;
  }
  function ownDraft(request, row) {
    if (row.user_id !== request.ctx.userId) throw forbidden('Only the person who made this claim can change it.');
    if (!['draft', 'rejected'].includes(row.status)) throw badRequest(`This claim is ${row.status}; it can no longer be edited.`);
  }
  async function retotal(tx, row) {
    const t = await tx.one(`SELECT COALESCE(sum(amount_paise), 0)::bigint AS total FROM expense_lines WHERE org_id = $1 AND claim_id = $2`, [row.org_id, row.id]);
    await tx.query(`UPDATE expense_claims SET total_paise = $3, updated_at = now() WHERE org_id = $1 AND id = $2`, [row.org_id, row.id, t.total]);
  }
  const eventData = (c) => ({ claim_id: c.id, number: c.number, title: c.title, user_id: c.user_id, total: toRupees(Number(c.total_paise)), note: c.decision_note ?? null });

  // ══════════════════════════════════════════════════════════════ CATEGORIES
  app.get('/expenses/categories', { preHandler: guard('expenses.claims.view') }, async (request) => ({
    data: (await categories(db, request.ctx.orgId)).map(shapeCategory),
  }));

  const categoryFields = { name: v.text(80, 1), monthly_limit: nullable(amount), requires_receipt: v.bool, active: v.bool };

  app.post('/expenses/categories', { preHandler: guard('expenses.policies.manage'), schema: { body: body(categoryFields, ['name']) } }, async (request, reply) => {
    await categories(db, request.ctx.orgId);
    try {
      const row = await db.one(
        `INSERT INTO expense_categories (id, org_id, name, monthly_limit_paise, requires_receipt, active)
         VALUES ($1, $2, $3, $4, COALESCE($5, true), COALESCE($6, true)) RETURNING *`,
        [id('excat'), request.ctx.orgId, request.body.name.trim(), request.body.monthly_limit ? toPaise(request.body.monthly_limit) : null,
          request.body.requires_receipt ?? null, request.body.active ?? null],
      );
      return reply.status(201).send({ data: shapeCategory(row) });
    } catch (error) {
      if (error.name === 'UniqueViolation') throw conflict('A category with that name already exists.');
      throw error;
    }
  });

  app.patch(
    '/expenses/categories/:categoryId',
    { preHandler: guard('expenses.policies.manage'), schema: { params: params({ categoryId: v.id('excat') }), body: body(categoryFields) } },
    async (request) => {
      const old = await db.one(`SELECT * FROM expense_categories WHERE org_id = $1 AND id = $2`, [request.ctx.orgId, request.params.categoryId]);
      if (!old) throw notFound('Category');
      const b = request.body;
      const row = await db.one(
        `UPDATE expense_categories SET name = $3, monthly_limit_paise = $4, requires_receipt = $5, active = $6
          WHERE org_id = $1 AND id = $2 RETURNING *`,
        [old.org_id, old.id, b.name?.trim() ?? old.name,
          b.monthly_limit === undefined ? old.monthly_limit_paise : b.monthly_limit === null ? null : toPaise(b.monthly_limit),
          b.requires_receipt ?? old.requires_receipt, b.active ?? old.active],
      );
      return { data: shapeCategory(row) };
    },
  );

  // ══════════════════════════════════════════════════════════════════ CLAIMS
  app.get(
    '/expenses/claims',
    {
      preHandler: guard('expenses.claims.view'),
      schema: { querystring: query({ scope: v.enum(['mine', 'team']), status: v.enum(['draft', 'submitted', 'approved', 'rejected', 'reimbursed']) }) },
    },
    async (request) => {
      const { orgId, userId } = request.ctx;
      const team = request.query.scope === 'team';
      if (team && !reviewer(request)) throw forbidden('Only approvers and finance can see everyone’s claims.');
      const values = [orgId];
      const where = ['org_id = $1'];
      if (!team) { values.push(userId); where.push(`user_id = $${values.length}`); }
      // Drafts are the claimant's own business.
      else where.push(`status <> 'draft'`);
      if (request.query.status) { values.push(request.query.status); where.push(`status = $${values.length}`); }
      if (request.query.q) { values.push(`%${request.query.q}%`); where.push(`(title ILIKE $${values.length} OR number ILIKE $${values.length})`); }
      const rows = await db.rows(
        `SELECT c.*, (SELECT count(*)::int FROM expense_lines l WHERE l.org_id = c.org_id AND l.claim_id = c.id) AS line_count
           FROM expense_claims c WHERE ${where.join(' AND ')}
          ORDER BY CASE status WHEN 'submitted' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, created_at DESC LIMIT 200`,
        values,
      );
      const totals = await db.one(
        `SELECT COALESCE(sum(total_paise) FILTER (WHERE status = 'submitted'), 0)::bigint AS pending,
                COALESCE(sum(total_paise) FILTER (WHERE status = 'approved'), 0)::bigint AS approved,
                COALESCE(sum(total_paise) FILTER (WHERE status = 'reimbursed' AND reimbursed_at >= date_trunc('month', now())), 0)::bigint AS reimbursed_month,
                count(*) FILTER (WHERE status = 'submitted')::int AS pending_count
           FROM expense_claims WHERE ${where.slice(0, 2).join(' AND ')}`,
        values.slice(0, team ? 1 : 2),
      );
      return {
        data: team ? await withNames(rows.map(shapeClaim)) : rows.map(shapeClaim),
        meta: {
          pending: toRupees(Number(totals.pending)), approved: toRupees(Number(totals.approved)),
          reimbursed_this_month: toRupees(Number(totals.reimbursed_month)), pending_count: totals.pending_count,
        },
      };
    },
  );

  app.post('/expenses/claims', { preHandler: guard('expenses.claims.create'), schema: { body: body({ title: v.text(160, 1) }, ['title']) } }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    if (!request.body.title.trim()) throw badRequest('Give the claim a title, e.g. “Client visit, Pune”.');
    const row = await db.transaction(async (tx) => {
      const counter = await tx.one(
        `INSERT INTO expense_counters (org_id, last_value) VALUES ($1, 1)
         ON CONFLICT (org_id) DO UPDATE SET last_value = expense_counters.last_value + 1 RETURNING last_value`,
        [orgId],
      );
      return tx.one(
        `INSERT INTO expense_claims (id, org_id, number, user_id, title) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id('exp'), orgId, `EXP-${String(counter.last_value).padStart(4, '0')}`, userId, request.body.title.trim()],
      );
    });
    return reply.status(201).send({ data: shapeClaim(row) });
  });

  app.get('/expenses/claims/:claimId', { preHandler: guard('expenses.claims.view'), schema: claimParams }, async (request) => {
    const row = await claim(db, request, request.params.claimId);
    const lines = await db.rows(
      `SELECT l.*, c.name AS category_name FROM expense_lines l JOIN expense_categories c ON c.org_id = l.org_id AND c.id = l.category_id
        WHERE l.org_id = $1 AND l.claim_id = $2 ORDER BY l.spent_on, l.created_at`,
      [row.org_id, row.id],
    );
    const [named] = await withNames([shapeClaim(row)]);
    return { data: { ...named, lines: lines.map(shapeLine), can_decide: request.ctx.can('expenses.claims.approve') && row.user_id !== request.ctx.userId } };
  });

  app.patch('/expenses/claims/:claimId', { preHandler: guard('expenses.claims.edit'), schema: { ...claimParams, body: body({ title: v.text(160, 1) }, ['title']) } }, async (request) => {
    const row = await db.transaction(async (tx) => {
      const old = await claim(tx, request, request.params.claimId, true);
      ownDraft(request, old);
      return tx.one(`UPDATE expense_claims SET title = $3, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`, [old.org_id, old.id, request.body.title.trim()]);
    });
    return { data: shapeClaim(row) };
  });

  app.delete('/expenses/claims/:claimId', { preHandler: guard('expenses.claims.edit'), schema: claimParams }, async (request) => {
    await db.transaction(async (tx) => {
      const old = await claim(tx, request, request.params.claimId, true);
      if (old.user_id !== request.ctx.userId || old.status !== 'draft') throw badRequest('Only your own draft claims can be deleted.');
      await tx.query(`DELETE FROM expense_claims WHERE org_id = $1 AND id = $2`, [old.org_id, old.id]);
    });
    return { data: { deleted: true } };
  });

  // ── lines ────────────────────────────────────────────────────────────────
  const lineFields = {
    spent_on: v.date, category_id: v.id('excat'), merchant: nullable(v.text(120)), description: v.text(500, 0), amount,
    receipt_url: nullable({ type: 'string', format: 'uri', maxLength: 1000 }), receipt_document_id: nullable(v.id('doc')),
  };
  async function assertCategory(tx, orgId, categoryId) {
    const row = await tx.one(`SELECT * FROM expense_categories WHERE org_id = $1 AND id = $2 AND active`, [orgId, categoryId]);
    if (!row) throw badRequest('Choose an active expense category.');
  }

  app.post(
    '/expenses/claims/:claimId/lines',
    { preHandler: guard('expenses.claims.edit'), schema: { ...claimParams, body: body(lineFields, ['spent_on', 'category_id', 'amount']) } },
    async (request, reply) => {
      const b = request.body;
      if (b.spent_on > new Date().toISOString().slice(0, 10)) throw badRequest('An expense cannot be dated in the future.');
      const line = await db.transaction(async (tx) => {
        const row = await claim(tx, request, request.params.claimId, true);
        ownDraft(request, row);
        await categories(tx, row.org_id);
        await assertCategory(tx, row.org_id, b.category_id);
        const created = await tx.one(
          `INSERT INTO expense_lines (id, org_id, claim_id, spent_on, category_id, merchant, description, amount_paise, receipt_url, receipt_document_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [id('exl'), row.org_id, row.id, b.spent_on, b.category_id, b.merchant ?? null, b.description ?? '', toPaise(b.amount), b.receipt_url ?? null, b.receipt_document_id ?? null],
        );
        await retotal(tx, row);
        return created;
      });
      return reply.status(201).send({ data: shapeLine(line) });
    },
  );

  app.patch(
    '/expenses/claims/:claimId/lines/:lineId',
    { preHandler: guard('expenses.claims.edit'), schema: { params: params({ claimId: v.id('exp'), lineId: v.id('exl') }), body: body(lineFields) } },
    async (request) => {
      const b = request.body;
      if (b.spent_on && b.spent_on > new Date().toISOString().slice(0, 10)) throw badRequest('An expense cannot be dated in the future.');
      const line = await db.transaction(async (tx) => {
        const row = await claim(tx, request, request.params.claimId, true);
        ownDraft(request, row);
        const old = await tx.one(`SELECT * FROM expense_lines WHERE org_id = $1 AND claim_id = $2 AND id = $3`, [row.org_id, row.id, request.params.lineId]);
        if (!old) throw notFound('Expense line');
        if (b.category_id) await assertCategory(tx, row.org_id, b.category_id);
        const updated = await tx.one(
          `UPDATE expense_lines SET spent_on = $4, category_id = $5, merchant = $6, description = $7, amount_paise = $8, receipt_url = $9, receipt_document_id = $10
            WHERE org_id = $1 AND claim_id = $2 AND id = $3 RETURNING *`,
          [row.org_id, row.id, old.id, b.spent_on ?? old.spent_on, b.category_id ?? old.category_id,
            b.merchant === undefined ? old.merchant : b.merchant, b.description ?? old.description,
            b.amount === undefined ? old.amount_paise : toPaise(b.amount),
            b.receipt_url === undefined ? old.receipt_url : b.receipt_url,
            b.receipt_document_id === undefined ? old.receipt_document_id : b.receipt_document_id],
        );
        await retotal(tx, row);
        return updated;
      });
      return { data: shapeLine(line) };
    },
  );

  app.delete('/expenses/claims/:claimId/lines/:lineId', { preHandler: guard('expenses.claims.edit'), schema: { params: params({ claimId: v.id('exp'), lineId: v.id('exl') }) } }, async (request) => {
    await db.transaction(async (tx) => {
      const row = await claim(tx, request, request.params.claimId, true);
      ownDraft(request, row);
      const gone = await tx.one(`DELETE FROM expense_lines WHERE org_id = $1 AND claim_id = $2 AND id = $3 RETURNING id`, [row.org_id, row.id, request.params.lineId]);
      if (!gone) throw notFound('Expense line');
      await retotal(tx, row);
    });
    return { data: { deleted: true } };
  });

  // ══════════════════════════════════════════════════════════════ LIFECYCLE
  app.post('/expenses/claims/:claimId/submit', { preHandler: guard('expenses.claims.edit'), schema: claimParams }, async (request) => {
    const row = await db.transaction(async (tx) => {
      const old = await claim(tx, request, request.params.claimId, true);
      ownDraft(request, old);
      const lines = await tx.rows(
        `SELECT l.*, c.name AS category_name, c.requires_receipt, c.monthly_limit_paise
           FROM expense_lines l JOIN expense_categories c ON c.org_id = l.org_id AND c.id = l.category_id
          WHERE l.org_id = $1 AND l.claim_id = $2`,
        [old.org_id, old.id],
      );
      if (!lines.length) throw badRequest('Add at least one expense before submitting.');
      const missing = lines.filter((l) => l.requires_receipt && !l.receipt_url && !l.receipt_document_id);
      if (missing.length) {
        throw badRequest(`Attach a receipt for: ${missing.map((l) => `${l.category_name} on ${l.spent_on}`).join(', ')}.`, { code: 'receipt_required' });
      }

      // Monthly limits, per person and category, counting claims already in
      // flight or paid this month. A breach is a warning for the approver.
      const warnings = [];
      const byMonthCategory = new Map();
      for (const l of lines) {
        if (!l.monthly_limit_paise) continue;
        const key = `${l.category_id}:${l.spent_on.slice(0, 7)}`;
        byMonthCategory.set(key, { line: l, sum: (byMonthCategory.get(key)?.sum ?? 0) + Number(l.amount_paise) });
      }
      for (const { line, sum } of byMonthCategory.values()) {
        const month = line.spent_on.slice(0, 7);
        const other = await tx.one(
          `SELECT COALESCE(sum(l.amount_paise), 0)::bigint AS s FROM expense_lines l
             JOIN expense_claims c ON c.org_id = l.org_id AND c.id = l.claim_id
            WHERE l.org_id = $1 AND c.user_id = $2 AND c.id <> $3 AND l.category_id = $4
              AND c.status IN ('submitted', 'approved', 'reimbursed') AND to_char(l.spent_on, 'YYYY-MM') = $5`,
          [old.org_id, old.user_id, old.id, line.category_id, month],
        );
        const total = sum + Number(other.s);
        if (total > Number(line.monthly_limit_paise)) {
          warnings.push({ category: line.category_name, month, limit: toRupees(Number(line.monthly_limit_paise)), claimed: toRupees(total) });
        }
      }

      const updated = await tx.one(
        `UPDATE expense_claims SET status = 'submitted', submitted_at = now(), policy_warnings = $3,
                decided_by = NULL, decided_at = NULL, decision_note = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING *`,
        [old.org_id, old.id, JSON.stringify(warnings)],
      );
      tx.emit({ type: EVENTS.EXPENSE_SUBMITTED, org_id: old.org_id, actor_id: request.ctx.userId, data: eventData(updated) });
      return updated;
    });
    return { data: shapeClaim(row) };
  });

  app.post('/expenses/claims/:claimId/withdraw', { preHandler: guard('expenses.claims.edit'), schema: claimParams }, async (request) => {
    const row = await db.transaction(async (tx) => {
      const old = await claim(tx, request, request.params.claimId, true);
      if (old.user_id !== request.ctx.userId) throw forbidden('Only the person who made this claim can withdraw it.');
      if (old.status !== 'submitted') throw badRequest('Only a submitted claim that is not yet decided can be withdrawn.');
      return tx.one(`UPDATE expense_claims SET status = 'draft', submitted_at = NULL, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`, [old.org_id, old.id]);
    });
    return { data: shapeClaim(row) };
  });

  app.post(
    '/expenses/claims/:claimId/decision',
    { preHandler: guard('expenses.claims.approve'), schema: { ...claimParams, body: body({ decision: v.enum(['approve', 'reject']), note: v.text(1000) }, ['decision']) } },
    async (request) => {
      const { userId } = request.ctx;
      const row = await db.transaction(async (tx) => {
        const old = await claim(tx, request, request.params.claimId, true);
        if (old.user_id === userId) throw forbidden('You cannot decide your own claim.');
        if (old.status !== 'submitted') throw badRequest(`This claim is ${old.status}, not waiting for a decision.`);
        if (request.body.decision === 'reject' && !request.body.note?.trim()) throw badRequest('Say why the claim is rejected — the claimant sees it.');
        const updated = await tx.one(
          `UPDATE expense_claims SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5, updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [old.org_id, old.id, request.body.decision === 'approve' ? 'approved' : 'rejected', userId, request.body.note?.trim() || null],
        );
        tx.emit({ type: request.body.decision === 'approve' ? EVENTS.EXPENSE_APPROVED : EVENTS.EXPENSE_REJECTED, org_id: old.org_id, actor_id: userId, data: eventData(updated) });
        return updated;
      });
      return { data: shapeClaim(row) };
    },
  );

  app.post(
    '/expenses/claims/:claimId/reimburse',
    { preHandler: guard('expenses.claims.reimburse'), schema: { ...claimParams, body: body({ reference: v.text(120, 0) }) } },
    async (request) => {
      const { userId } = request.ctx;
      const row = await db.transaction(async (tx) => {
        const old = await claim(tx, request, request.params.claimId, true);
        if (old.status !== 'approved') throw badRequest('Only an approved claim can be marked reimbursed.');
        if (old.user_id === userId) throw forbidden('You cannot reimburse your own claim.');
        const updated = await tx.one(
          `UPDATE expense_claims SET status = 'reimbursed', reimbursed_by = $3, reimbursed_at = now(), payment_reference = $4, updated_at = now()
            WHERE org_id = $1 AND id = $2 RETURNING *`,
          [old.org_id, old.id, userId, request.body?.reference?.trim() || null],
        );
        tx.emit({ type: EVENTS.EXPENSE_REIMBURSED, org_id: old.org_id, actor_id: userId, data: eventData(updated) });
        return updated;
      });
      return { data: shapeClaim(row) };
    },
  );

  app.get('/expenses/widgets', { preHandler: guard('expenses.claims.view') }, async (request) => {
    if (!request.ctx.can('expenses.claims.approve')) return { data: {} };
    const row = await db.one(`SELECT count(*)::int AS n FROM expense_claims WHERE org_id = $1 AND status = 'submitted' AND user_id <> $2`, [request.ctx.orgId, request.ctx.userId]);
    return { data: { 'expenses.pending_approval': row.n } };
  });
}
