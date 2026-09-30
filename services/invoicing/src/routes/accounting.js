import { createHash } from 'node:crypto';
import { id } from '@nexus/db-kit';
import {
  body, params, query, validate as v, requireApp, requirePermission, badRequest, notFound, resource, nullable, amount,
} from '@nexus/service-kit';
import { ensureChart, postEntry, reverseEntry, balances, DEBIT_NORMAL } from '../lib/ledger.js';
import { toPaise, toRupees } from '../lib/money.js';

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
const signed = (type, debit, credit) => (DEBIT_NORMAL.has(type) ? toPaise(debit) - toPaise(credit) : toPaise(credit) - toPaise(debit));
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;

/**
 * Accounting: the general ledger, fed automatically by sales, purchases,
 * payroll and expenses (see accounting-consumers.js), plus the manual
 * journals, bank reconciliation and statements an accountant needs.
 */
export async function accountingRoutes(app) {
  const { db } = app;
  const guard = (permission) => [app.loadContext, requireApp('accounting'), requirePermission(permission)];

  // ── chart of accounts ─────────────────────────────────────────────────────
  resource(app, {
    path: '/accounting/accounts', table: 'accounts', prefix: 'acc', appSlug: 'accounting', label: 'Account',
    permissions: { view: 'accounting.coa.view', manage: 'accounting.coa.manage' },
    fields: { code: { type: 'string', pattern: '^[0-9A-Za-z.-]{1,12}$' }, name: v.text(120, 1), type: v.enum(TYPES), description: v.text(500, 0), active: v.bool },
    required: ['code', 'name', 'type'], search: ['code', 'name'], filters: { type: v.enum(TYPES), active: v.bool },
    defaultSort: 'code ASC', uniqueMessage: 'Another account already uses that code.',
    columns: `t.*, COALESCE(b.debit, 0)::numeric(14,2) AS debit, COALESCE(b.credit, 0)::numeric(14,2) AS credit`,
    from: `accounts t LEFT JOIN (SELECT account_id, sum(debit) AS debit, sum(credit) AS credit FROM journal_lines GROUP BY account_id) b ON b.account_id = t.id`,
    shape: (row) => ({ ...row, balance: toRupees(signed(row.type, row.debit ?? 0, row.credit ?? 0)) }),
    hooks: {
      beforeList: (request) => ensureChart(db, request.ctx.orgId),
      async beforeUpdate(tx, data, old) {
        if (data.type && data.type !== old.type) {
          const used = await tx.one(`SELECT 1 FROM journal_lines WHERE org_id = $1 AND account_id = $2 LIMIT 1`, [old.org_id, old.id]);
          if (used) throw badRequest('This account has postings, so its type cannot change.');
        }
        if (data.active === false && old.system_key) throw badRequest('Automatic postings use this account, so it cannot be archived.');
        return data;
      },
      async beforeDelete(tx, old) {
        if (old.system_key) throw badRequest('Automatic postings use this account, so it cannot be deleted.');
        const used = await tx.one(`SELECT 1 FROM journal_lines WHERE org_id = $1 AND account_id = $2 LIMIT 1`, [old.org_id, old.id]);
        if (used) throw badRequest('This account has postings. Archive it instead.');
      },
    },
  });

  app.get('/accounting/accounts/:id/ledger', {
    preHandler: guard('accounting.ledger.view'),
    schema: { params: params({ id: v.id('acc') }), querystring: query({ from: v.date, to: v.date }) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const account = await db.one(`SELECT * FROM accounts WHERE org_id = $1 AND id = $2`, [orgId, request.params.id]);
    if (!account) throw notFound('Account');
    const from = request.query.from ?? `${new Date().getFullYear()}-01-01`;
    const to = request.query.to ?? today();
    const opening = await db.one(
      `SELECT COALESCE(sum(l.debit), 0) AS debit, COALESCE(sum(l.credit), 0) AS credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.org_id = $1 AND l.account_id = $2 AND e.entry_date < $3::date`,
      [orgId, account.id, from],
    );
    const lines = await db.rows(
      `SELECT l.id, l.debit, l.credit, l.description, e.id AS entry_id, e.number, e.entry_date, e.memo, e.source
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.org_id = $1 AND l.account_id = $2 AND e.entry_date BETWEEN $3::date AND $4::date
        ORDER BY e.entry_date, e.created_at, l.position LIMIT 2000`,
      [orgId, account.id, from, to],
    );
    let running = signed(account.type, opening.debit, opening.credit);
    const openingBalance = running;
    const withBalance = lines.map((l) => {
      running += signed(account.type, l.debit, l.credit);
      return { ...l, balance: toRupees(running) };
    });
    return { data: { account, from, to, opening_balance: toRupees(openingBalance), closing_balance: toRupees(running), lines: withBalance } };
  });

  // ── journal ───────────────────────────────────────────────────────────────
  const SOURCES = ['manual', 'invoice', 'payment', 'pos', 'pos_refund', 'store', 'purchase', 'expense', 'payroll', 'depreciation', 'asset', 'bank', 'reversal', 'opening'];
  app.get('/accounting/journal', {
    preHandler: guard('accounting.journal.view'),
    schema: { querystring: query({ source: v.enum(SOURCES), from: v.date, to: v.date }) },
  }, async (request) => {
    const qs = request.query;
    const values = [request.ctx.orgId];
    const where = ['e.org_id = $1'];
    if (qs.source) { values.push(qs.source); where.push(`e.source = $${values.length}`); }
    if (qs.from) { values.push(qs.from); where.push(`e.entry_date >= $${values.length}::date`); }
    if (qs.to) { values.push(qs.to); where.push(`e.entry_date <= $${values.length}::date`); }
    if (qs.q) { values.push(`%${qs.q}%`); where.push(`(e.number ILIKE $${values.length} OR e.memo ILIKE $${values.length})`); }
    const limit = qs.limit ?? 25;
    const offset = ((qs.page ?? 1) - 1) * limit;
    const clause = where.join(' AND ');
    const [rows, total] = await Promise.all([
      db.rows(`SELECT e.* FROM journal_entries e WHERE ${clause} ORDER BY e.entry_date DESC, e.created_at DESC LIMIT ${limit} OFFSET ${offset}`, values),
      db.one(`SELECT count(*)::int AS n FROM journal_entries e WHERE ${clause}`, values),
    ]);
    return { data: rows, meta: { total: total.n, page: qs.page ?? 1, limit, pages: Math.ceil(total.n / limit) || 1 } };
  });

  app.get('/accounting/journal/:id', { preHandler: guard('accounting.journal.view'), schema: { params: params({ id: v.id('je') }) } }, async (request) => {
    const { orgId } = request.ctx;
    const entry = await db.one(`SELECT * FROM journal_entries WHERE org_id = $1 AND id = $2`, [orgId, request.params.id]);
    if (!entry) throw notFound('Journal entry');
    const lines = await db.rows(
      `SELECT l.*, a.code, a.name AS account_name FROM journal_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.org_id = $1 AND l.entry_id = $2 ORDER BY l.position`,
      [orgId, entry.id],
    );
    return { data: { ...entry, lines } };
  });

  app.post('/accounting/journal', {
    preHandler: guard('accounting.journal.post'),
    schema: {
      body: body({
        entry_date: v.date, memo: v.text(500, 1),
        lines: { type: 'array', minItems: 2, maxItems: 100, items: body({ account_id: v.id('acc'), debit: amount, credit: amount, description: v.text(300, 0) }, ['account_id']) },
      }, ['memo', 'lines']),
    },
  }, async (request, reply) => {
    const { orgId, userId } = request.ctx;
    const entry = await db.transaction((tx) => postEntry(tx, {
      orgId, userId, date: request.body.entry_date, memo: request.body.memo.trim(), source: 'manual', lines: request.body.lines,
    }));
    return reply.status(201).send({ data: entry });
  });

  app.post('/accounting/journal/:id/reverse', {
    preHandler: guard('accounting.journal.post'),
    schema: { params: params({ id: v.id('je') }), body: body({ memo: v.text(500, 0) }) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const reversal = await db.transaction((tx) => reverseEntry(tx, { orgId, userId, entryId: request.params.id, memo: request.body?.memo }));
    return { data: reversal };
  });

  // ── statements ────────────────────────────────────────────────────────────
  app.get('/accounting/reports/trial-balance', {
    preHandler: guard('accounting.reports.view'), schema: { querystring: query({ as_of: v.date }) },
  }, async (request) => {
    const rows = await balances(db, request.ctx.orgId, { to: request.query.as_of ?? today() });
    const lines = rows.filter((r) => Number(r.debit) || Number(r.credit)).map((r) => {
      const net = toPaise(r.debit) - toPaise(r.credit);
      return { id: r.id, code: r.code, name: r.name, type: r.type, debit: toRupees(Math.max(net, 0)), credit: toRupees(Math.max(-net, 0)) };
    });
    const debit = lines.reduce((s, l) => s + toPaise(l.debit), 0);
    const credit = lines.reduce((s, l) => s + toPaise(l.credit), 0);
    return { data: { as_of: request.query.as_of ?? today(), lines, total_debit: toRupees(debit), total_credit: toRupees(credit), balanced: debit === credit } };
  });

  async function profitAndLoss(orgId, from, to) {
    const rows = await balances(db, orgId, { from, to });
    const income = rows.filter((r) => r.type === 'income' && toPaise(r.balance) !== 0);
    const expense = rows.filter((r) => r.type === 'expense' && toPaise(r.balance) !== 0);
    const totalIncome = income.reduce((s, r) => s + toPaise(r.balance), 0);
    const totalExpense = expense.reduce((s, r) => s + toPaise(r.balance), 0);
    return { from, to, income, expense, total_income: toRupees(totalIncome), total_expense: toRupees(totalExpense), net_profit: toRupees(totalIncome - totalExpense) };
  }

  app.get('/accounting/reports/profit-loss', {
    preHandler: guard('accounting.reports.view'), schema: { querystring: query({ from: v.date, to: v.date }) },
  }, async (request) => ({ data: await profitAndLoss(request.ctx.orgId, request.query.from ?? monthStart(), request.query.to ?? today()) }));

  app.get('/accounting/reports/balance-sheet', {
    preHandler: guard('accounting.reports.view'), schema: { querystring: query({ as_of: v.date }) },
  }, async (request) => {
    const asOf = request.query.as_of ?? today();
    const rows = await balances(db, request.ctx.orgId, { to: asOf });
    const pick = (type) => rows.filter((r) => r.type === type && toPaise(r.balance) !== 0);
    const sum = (list) => list.reduce((s, r) => s + toPaise(r.balance), 0);
    // Profit not yet closed into retained earnings is part of equity.
    const earnings = sum(rows.filter((r) => r.type === 'income')) - sum(rows.filter((r) => r.type === 'expense'));
    const assets = pick('asset');
    const liabilities = pick('liability');
    const equity = pick('equity');
    const totalEquity = sum(equity) + earnings;
    return {
      data: {
        as_of: asOf, assets, liabilities, equity, current_earnings: toRupees(earnings),
        total_assets: toRupees(sum(assets)), total_liabilities: toRupees(sum(liabilities)), total_equity: toRupees(totalEquity),
        balanced: sum(assets) === sum(liabilities) + totalEquity,
      },
    };
  });

  // ── bank ──────────────────────────────────────────────────────────────────
  const banks = resource(app, {
    path: '/accounting/bank-accounts', table: 'bank_accounts', prefix: 'bank', appSlug: 'accounting', label: 'Bank account',
    permissions: { view: 'accounting.bank.view', manage: 'accounting.coa.manage' },
    fields: { name: v.text(120, 1), bank_name: nullable(v.text(120)), account_last4: nullable({ type: 'string', pattern: '^[0-9]{4}$' }), ifsc: nullable({ type: 'string', pattern: '^[A-Z]{4}0[A-Z0-9]{6}$' }) },
    required: ['name'], search: ['name', 'bank_name'], defaultSort: 'name ASC',
    columns: `t.*, a.code AS account_code, COALESCE((SELECT sum(debit) - sum(credit) FROM journal_lines l WHERE l.account_id = t.account_id), 0)::numeric(14,2) AS book_balance,
              (SELECT count(*)::int FROM bank_transactions x WHERE x.bank_account_id = t.id AND x.matched_line_id IS NULL) AS unmatched`,
    from: 'bank_accounts t JOIN accounts a ON a.id = t.account_id',
    hooks: {
      async beforeCreate(tx, data, request) {
        const { orgId, userId } = request.ctx;
        await ensureChart(tx, orgId);
        // Each bank account is its own ledger account under Bank; the first
        // one simply takes over the default Bank account.
        const unused = await tx.one(
          `SELECT a.* FROM accounts a WHERE a.org_id = $1 AND a.system_key = 'bank' AND NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.account_id = a.id)`,
          [orgId],
        );
        let ledger = unused;
        if (ledger) {
          await tx.query(`UPDATE accounts SET name = $3, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, ledger.id, data.name]);
        } else {
          const count = await tx.one(`SELECT count(*)::int AS n FROM accounts WHERE org_id = $1 AND code LIKE '101%'`, [orgId]);
          ledger = await tx.one(
            `INSERT INTO accounts (id, org_id, code, name, type, created_by) VALUES ($1,$2,$3,$4,'asset',$5) RETURNING *`,
            [id('acc'), orgId, `101${count.n}`, data.name, userId],
          );
        }
        return { ...data, account_id: ledger.id };
      },
      async beforeDelete(tx, old) {
        const used = await tx.one(`SELECT 1 FROM bank_transactions WHERE bank_account_id = $1 LIMIT 1`, [old.id]);
        if (used) throw badRequest('This account has statement lines. It cannot be deleted.');
      },
    },
  });

  app.get('/accounting/bank-accounts/:id/transactions', {
    preHandler: guard('accounting.bank.view'),
    schema: { params: params({ id: v.id('bank') }), querystring: query({ status: v.enum(['matched', 'unmatched']) }) },
  }, async (request) => {
    const { orgId } = request.ctx;
    const bank = await banks.load(db, orgId, request.params.id);
    const where = request.query.status === 'matched' ? 'AND x.matched_line_id IS NOT NULL' : request.query.status === 'unmatched' ? 'AND x.matched_line_id IS NULL' : '';
    const rows = await db.rows(
      `SELECT x.*, e.number AS matched_entry, e.memo AS matched_memo FROM bank_transactions x
         LEFT JOIN journal_lines l ON l.id = x.matched_line_id LEFT JOIN journal_entries e ON e.id = l.entry_id
        WHERE x.org_id = $1 AND x.bank_account_id = $2 ${where} ORDER BY x.txn_date DESC, x.created_at DESC LIMIT 500`,
      [orgId, bank.id],
    );
    // Suggest ledger lines on this account with the same amount within a week.
    const suggestions = {};
    for (const txn of rows.filter((x) => !x.matched_line_id).slice(0, 100)) {
      const amountPaise = toPaise(txn.amount);
      suggestions[txn.id] = await db.rows(
        `SELECT l.id, l.debit, l.credit, e.number, e.entry_date, e.memo FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.org_id = $1 AND l.account_id = $2 AND ${amountPaise > 0 ? 'l.debit' : 'l.credit'} = $3
            AND e.entry_date BETWEEN $4::date - 7 AND $4::date + 7
            AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_line_id = l.id)
          ORDER BY abs(e.entry_date - $4::date) LIMIT 3`,
        [orgId, bank.account_id, toRupees(Math.abs(amountPaise)), txn.txn_date],
      );
    }
    return { data: rows, meta: { bank, suggestions } };
  });

  app.post('/accounting/bank-accounts/:id/import', {
    preHandler: guard('accounting.bank.reconcile'),
    schema: {
      params: params({ id: v.id('bank') }),
      body: body({ rows: { type: 'array', minItems: 1, maxItems: 2000, items: body({ date: v.date, description: v.text(500, 0), reference: v.text(120, 0), amount: { anyOf: [{ type: 'number' }, { type: 'string', pattern: '^-?\\d+(\\.\\d{1,2})?$' }] } }, ['date', 'amount']) } }, ['rows']),
    },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const bank = await banks.load(db, orgId, request.params.id);
    let added = 0;
    await db.transaction(async (tx) => {
      const seen = new Map();
      for (const row of request.body.rows) {
        const value = toPaise(row.amount);
        if (value === 0) continue;
        const base = `${row.date}|${value}|${(row.description ?? '').trim().toLowerCase()}|${row.reference ?? ''}`;
        // Two identical lines on one statement are two transactions.
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const hash = createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 40);
        const inserted = await tx.one(
          `INSERT INTO bank_transactions (id, org_id, bank_account_id, txn_date, description, reference, amount, import_hash, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
          [id('btx'), orgId, bank.id, row.date, row.description ?? '', row.reference || null, toRupees(value), hash, userId],
        );
        if (inserted) added += 1;
      }
    });
    return { data: { added, skipped: request.body.rows.length - added } };
  });

  const txnParams = { params: params({ id: v.id('btx') }) };
  async function bankTxn(tx, orgId, txnId) {
    const row = await tx.one(
      `SELECT x.*, b.account_id FROM bank_transactions x JOIN bank_accounts b ON b.id = x.bank_account_id WHERE x.org_id = $1 AND x.id = $2 FOR UPDATE OF x`,
      [orgId, txnId],
    );
    if (!row) throw notFound('Statement line');
    return row;
  }

  app.post('/accounting/bank-transactions/:id/match', {
    preHandler: guard('accounting.bank.reconcile'), schema: { ...txnParams, body: body({ line_id: v.id('jl') }, ['line_id']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const txn = await bankTxn(tx, orgId, request.params.id);
      if (txn.matched_line_id) throw badRequest('This statement line is already matched.');
      const line = await tx.one(`SELECT * FROM journal_lines WHERE org_id = $1 AND id = $2`, [orgId, request.body.line_id]);
      if (!line || line.account_id !== txn.account_id) throw badRequest('Match it to a posting on this bank’s ledger account.');
      const expected = toPaise(txn.amount);
      const actual = toPaise(line.debit) - toPaise(line.credit);
      if (expected !== actual) throw badRequest('The amounts differ. Match a posting of the same amount, or post the difference.');
      return tx.one(`UPDATE bank_transactions SET matched_line_id = $3, matched_by = $4, matched_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`, [orgId, txn.id, line.id, userId]);
    });
    return { data: row };
  });

  app.post('/accounting/bank-transactions/:id/unmatch', { preHandler: guard('accounting.bank.reconcile'), schema: txnParams }, async (request) => {
    const row = await db.one(
      `UPDATE bank_transactions SET matched_line_id = NULL, matched_by = NULL, matched_at = NULL WHERE org_id = $1 AND id = $2 RETURNING *`,
      [request.ctx.orgId, request.params.id],
    );
    if (!row) throw notFound('Statement line');
    return { data: row };
  });

  // A line with nothing in the books yet (bank charges, interest): post it
  // against the chosen account and match it in one step.
  app.post('/accounting/bank-transactions/:id/post', {
    preHandler: [...guard('accounting.bank.reconcile'), requirePermission('accounting.journal.post')],
    schema: { ...txnParams, body: body({ account_id: v.id('acc'), memo: v.text(300, 0) }, ['account_id']) },
  }, async (request) => {
    const { orgId, userId } = request.ctx;
    const row = await db.transaction(async (tx) => {
      const txn = await bankTxn(tx, orgId, request.params.id);
      if (txn.matched_line_id) throw badRequest('This statement line is already matched.');
      const value = toPaise(txn.amount);
      const entry = await postEntry(tx, {
        orgId, userId, date: txn.txn_date, memo: request.body.memo || txn.description || 'Bank transaction', source: 'bank', sourceRef: txn.id,
        lines: value > 0
          ? [{ account_id: txn.account_id, debit: toRupees(value) }, { account_id: request.body.account_id, credit: toRupees(value) }]
          : [{ account_id: request.body.account_id, debit: toRupees(-value) }, { account_id: txn.account_id, credit: toRupees(-value) }],
      });
      const bankLine = await tx.one(`SELECT id FROM journal_lines WHERE entry_id = $1 AND account_id = $2 ORDER BY position LIMIT 1`, [entry.id, txn.account_id]);
      return tx.one(`UPDATE bank_transactions SET matched_line_id = $3, matched_by = $4, matched_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`, [orgId, txn.id, bankLine.id, userId]);
    });
    return { data: row };
  });

  // ── overview ──────────────────────────────────────────────────────────────
  async function cashPosition(orgId) {
    const rows = await balances(db, orgId, { to: today() });
    const banked = new Set((await db.rows(`SELECT account_id FROM bank_accounts WHERE org_id = $1`, [orgId])).map((r) => r.account_id));
    const cash = rows.filter((r) => r.system_key === 'cash' || r.system_key === 'bank' || banked.has(r.id));
    return { accounts: cash.map((r) => ({ id: r.id, code: r.code, name: r.name, balance: r.balance })), total: toRupees(cash.reduce((s, r) => s + toPaise(r.balance), 0)), rows };
  }

  app.get('/accounting/overview', { preHandler: guard('accounting.ledger.view') }, async (request) => {
    const { orgId } = request.ctx;
    const [cash, month, recent] = await Promise.all([
      cashPosition(orgId),
      profitAndLoss(orgId, monthStart(), today()),
      db.rows(`SELECT * FROM journal_entries WHERE org_id = $1 ORDER BY created_at DESC LIMIT 8`, [orgId]),
    ]);
    const bal = (key) => cash.rows.find((r) => r.system_key === key)?.balance ?? '0.00';
    return {
      data: {
        cash_position: cash.total, cash_accounts: cash.accounts, receivables: bal('ar'), payables: bal('ap'), gst_payable: toRupees(toPaise(bal('gst_output')) - toPaise(bal('gst_input'))),
        month_income: month.total_income, month_expense: month.total_expense, month_profit: month.net_profit, recent_entries: recent,
      },
    };
  });

  app.get('/accounting/widgets', { preHandler: guard('accounting.ledger.view') }, async (request) => {
    const { orgId } = request.ctx;
    const [cash, month] = await Promise.all([cashPosition(orgId), profitAndLoss(orgId, monthStart(), today())]);
    return { data: { 'accounting.cash_position': cash.total, 'accounting.pnl': month.net_profit } };
  });
}
