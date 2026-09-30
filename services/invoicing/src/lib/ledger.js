import { id } from '@nexus/db-kit';
import { badRequest } from '@nexus/service-kit';
import { EVENTS } from '@nexus/contracts/events';
import { toPaise, toRupees } from './money.js';

/**
 * A small Indian-business chart of accounts, created the first time anything
 * posts. `key` is how automatic postings find an account; customers can
 * rename and renumber freely without breaking them.
 */
export const DEFAULT_CHART = [
  ['1000', 'Cash in hand', 'asset', 'cash'],
  ['1010', 'Bank', 'asset', 'bank'],
  ['1100', 'Accounts receivable', 'asset', 'ar'],
  ['1200', 'Inventory', 'asset', 'inventory'],
  ['1300', 'GST input credit', 'asset', 'gst_input'],
  ['1500', 'Fixed assets', 'asset', 'fixed_assets'],
  ['1510', 'Accumulated depreciation', 'asset', 'accumulated_depreciation'],
  ['2000', 'Accounts payable', 'liability', 'ap'],
  ['2100', 'GST payable', 'liability', 'gst_output'],
  ['2200', 'Statutory dues (PF, ESI, TDS)', 'liability', 'statutory_payable'],
  ['3000', 'Owner’s capital', 'equity', 'capital'],
  ['3100', 'Retained earnings', 'equity', 'retained_earnings'],
  ['4000', 'Sales', 'income', 'sales'],
  ['4100', 'Other income', 'income', 'other_income'],
  ['5000', 'Cost of goods sold', 'expense', 'cogs'],
  ['6000', 'Salaries and wages', 'expense', 'salaries'],
  ['6100', 'Rent', 'expense', 'rent'],
  ['6200', 'Employee expenses', 'expense', 'employee_expenses'],
  ['6300', 'Depreciation', 'expense', 'depreciation'],
  ['6400', 'Bank charges', 'expense', 'bank_charges'],
  ['6500', 'General expenses', 'expense', 'general_expenses'],
  ['6600', 'Loss on asset disposal', 'expense', 'disposal_loss'],
];

/** Debit-normal accounts grow with debits; the rest grow with credits. */
export const DEBIT_NORMAL = new Set(['asset', 'expense']);

export async function ensureChart(store, orgId) {
  const any = await store.one(`SELECT 1 FROM accounts WHERE org_id = $1 LIMIT 1`, [orgId]);
  if (any) return;
  for (const [code, name, type, key] of DEFAULT_CHART) {
    await store.query(
      `INSERT INTO accounts (id, org_id, code, name, type, system_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [id('acc'), orgId, code, name, type, key],
    );
  }
}

async function accountByKey(tx, orgId, key) {
  let row = await tx.one(`SELECT * FROM accounts WHERE org_id = $1 AND system_key = $2`, [orgId, key]);
  if (!row) {
    await ensureChart(tx, orgId);
    row = await tx.one(`SELECT * FROM accounts WHERE org_id = $1 AND system_key = $2`, [orgId, key]);
  }
  if (!row) throw new Error(`no ledger account for "${key}"`);
  return row;
}

export async function nextFinanceNumber(tx, orgId, kind, prefix, padding = 5) {
  const row = await tx.one(
    `INSERT INTO finance_counters (org_id, kind, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (org_id, kind) DO UPDATE SET last_value = finance_counters.last_value + 1 RETURNING last_value`,
    [orgId, kind],
  );
  return `${prefix}-${String(row.last_value).padStart(padding, '0')}`;
}

/**
 * Post a balanced journal entry. Lines name an account by id or by system
 * key; zero lines are dropped. Returns the entry — or the existing one, if
 * this source document was already posted.
 */
export async function postEntry(tx, { orgId, userId = null, date, memo = '', source = 'manual', sourceRef = null, reverses = null, lines }) {
  if (sourceRef) {
    const existing = await tx.one(`SELECT * FROM journal_entries WHERE org_id = $1 AND source = $2 AND source_ref = $3`, [orgId, source, sourceRef]);
    if (existing) return existing;
  }
  await ensureChart(tx, orgId);

  const resolved = [];
  for (const line of lines) {
    const debit = toPaise(line.debit ?? 0);
    const credit = toPaise(line.credit ?? 0);
    if (debit < 0 || credit < 0) throw badRequest('Amounts cannot be negative.');
    if (debit === 0 && credit === 0) continue;
    if (debit > 0 && credit > 0) throw badRequest('A line is either a debit or a credit, not both.');
    let account;
    if (line.account_id) {
      account = await tx.one(`SELECT * FROM accounts WHERE org_id = $1 AND id = $2`, [orgId, line.account_id]);
      if (!account) throw badRequest('Choose accounts from this workspace’s chart of accounts.');
      if (!account.active) throw badRequest(`${account.code} ${account.name} is archived.`);
    } else {
      account = await accountByKey(tx, orgId, line.key);
    }
    resolved.push({ account, debit, credit, description: line.description ?? '' });
  }
  const debits = resolved.reduce((s, l) => s + l.debit, 0);
  const credits = resolved.reduce((s, l) => s + l.credit, 0);
  if (resolved.length < 2) throw badRequest('A journal entry needs at least two lines.');
  if (debits !== credits) {
    throw badRequest(`Debits (₹${toRupees(debits)}) and credits (₹${toRupees(credits)}) must be equal.`, { code: 'unbalanced' });
  }

  const entry = await tx.one(
    `INSERT INTO journal_entries (id, org_id, number, entry_date, memo, source, source_ref, total, reverses_id, created_by)
     VALUES ($1,$2,$3,COALESCE($4::date, current_date),$5,$6,$7,$8,$9,$10)
     ON CONFLICT (org_id, source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING *`,
    [id('je'), orgId, await nextFinanceNumber(tx, orgId, 'journal', 'JE'), date ?? null, memo, source, sourceRef, toRupees(debits), reverses, userId],
  );
  if (!entry) {
    return tx.one(`SELECT * FROM journal_entries WHERE org_id = $1 AND source = $2 AND source_ref = $3`, [orgId, source, sourceRef]);
  }
  for (const [position, line] of resolved.entries()) {
    await tx.query(
      `INSERT INTO journal_lines (id, org_id, entry_id, position, account_id, debit, credit, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id('jl'), orgId, entry.id, position, line.account.id, toRupees(line.debit), toRupees(line.credit), line.description],
    );
  }
  tx.emit({ type: EVENTS.JOURNAL_POSTED, org_id: orgId, actor_id: userId, data: { entry_id: entry.id, number: entry.number, source, total: entry.total } });
  return entry;
}

/** Undo an entry with its mirror image, dated today. The original stays. */
export async function reverseEntry(tx, { orgId, userId, entryId, memo }) {
  const entry = await tx.one(`SELECT * FROM journal_entries WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, entryId]);
  if (!entry) throw badRequest('That journal entry does not exist.');
  if (entry.reversed_by_id) throw badRequest(`${entry.number} was already reversed.`);
  if (entry.reverses_id) throw badRequest('A reversal cannot itself be reversed. Post a new entry instead.');
  const lines = await tx.rows(`SELECT * FROM journal_lines WHERE org_id = $1 AND entry_id = $2 ORDER BY position`, [orgId, entry.id]);
  const reversal = await postEntry(tx, {
    orgId, userId, memo: memo || `Reversal of ${entry.number}${entry.memo ? `: ${entry.memo}` : ''}`,
    source: 'reversal', sourceRef: entry.id, reverses: entry.id,
    lines: lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, description: l.description })),
  });
  await tx.query(`UPDATE journal_entries SET reversed_by_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, entry.id, reversal.id]);
  return reversal;
}

/**
 * Balance per account up to a date (or within a range), signed the way the
 * account naturally reads: an asset's balance is debits minus credits, a
 * liability's is credits minus debits.
 */
export async function balances(store, orgId, { from = null, to = null } = {}) {
  await ensureChart(store, orgId);
  // The date range filters postings, never accounts: an account with nothing
  // in the range still appears, at zero.
  const rows = await store.rows(
    `SELECT a.id, a.code, a.name, a.type, a.system_key, a.active,
            COALESCE(t.debit, 0)::numeric(14,2) AS debit, COALESCE(t.credit, 0)::numeric(14,2) AS credit
       FROM accounts a
       LEFT JOIN (
         SELECT l.account_id, sum(l.debit) AS debit, sum(l.credit) AS credit
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.org_id = $1 AND ($2::date IS NULL OR e.entry_date >= $2::date) AND ($3::date IS NULL OR e.entry_date <= $3::date)
          GROUP BY l.account_id
       ) t ON t.account_id = a.id
      WHERE a.org_id = $1
      ORDER BY a.code`,
    [orgId, from, to],
  );
  return rows.map((r) => {
    const net = toPaise(r.debit) - toPaise(r.credit);
    return { ...r, balance: toRupees(DEBIT_NORMAL.has(r.type) ? net : -net) };
  });
}
