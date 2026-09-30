'use client';

import { useCallback, useEffect, useState } from 'react';
import { Landmark, Upload, Link2, Plus, Unlink, CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, date } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { RecordForm, useOptions, clearOptionCache } from '@/components/data/resource-page';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

/** Parse a pasted statement: date, description, amount (or debit/credit columns). */
export function parseStatement(text) {
  const rows = [];
  const toIso = (v) => {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (!m) return null;
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // Indian banks: day first
  };
  const num = (v) => (v === undefined || v.trim() === '' ? 0 : Number(v.replace(/[₹,\s]/g, '')));
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = raw.split(raw.includes('\t') ? '\t' : ',').map((c) => c.replace(/^"|"$/g, ''));
    const when = toIso(cells[0] ?? '');
    if (!when) continue; // header or junk
    let amount;
    if (cells.length >= 4) amount = num(cells[3]) - num(cells[2]); // date, narration, withdrawal, deposit
    else amount = num(cells[2]);
    if (!Number.isFinite(amount) || amount === 0) continue;
    rows.push({ date: when, description: (cells[1] ?? '').trim(), amount: amount.toFixed(2) });
  }
  return rows;
}

export default function BankClient() {
  const { can } = useWorkspace();
  const [banks, setBanks] = useState(null);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api.get('/accounting/bank-accounts').then((r) => {
    setBanks(r.data);
    setSelected((s) => s ?? r.data[0]?.id ?? null);
  }).catch(() => setBanks([])), []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <PageHeader title="Bank" description="Import your statement and tick off each line against the books. Anything the books do not have yet — charges, interest — you can post in one click."
        actions={can('accounting.coa.manage') && <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add bank account</Button>} />
      {!banks ? <TableSkeleton rows={3} columns={3} /> : banks.length === 0 ? (
        <Card><EmptyState icon={Landmark} title="No bank accounts yet" description="Add your current account to start reconciling." action={can('accounting.coa.manage') && <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add bank account</Button>} /></Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            {banks.map((b) => (
              <button key={b.id} onClick={() => setSelected(b.id)} className={cn('panel min-w-[14rem] p-4 text-left', selected === b.id && 'ring-2 ring-[var(--color-brand-500)]')}>
                <p className="font-medium">{b.name}</p>
                <p className="text-xs text-[var(--text-tertiary)]">{[b.bank_name, b.account_last4 && `•••• ${b.account_last4}`].filter(Boolean).join(' · ') || b.account_code}</p>
                <p className="metric mt-2 text-lg font-semibold">{money(b.book_balance)}</p>
                {b.unmatched > 0 && <Badge size="sm" tone="caution">{b.unmatched} to reconcile</Badge>}
              </button>
            ))}
          </div>
          {selected && <Transactions key={selected} bankId={selected} onChanged={load} />}
        </>
      )}
      {adding && (
        <RecordForm endpoint="/accounting/bank-accounts" entity="bank account" record={{}}
          fields={[
            { key: 'name', label: 'Name', required: true, placeholder: 'HDFC current account' },
            { key: 'bank_name', label: 'Bank' },
            { key: 'account_last4', label: 'Last 4 digits' },
            { key: 'ifsc', label: 'IFSC' },
          ]}
          onClose={() => setAdding(false)} onSaved={(b) => { clearOptionCache(); setSelected(b.id); load(); }} />
      )}
    </div>
  );
}

function Transactions({ bankId, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [status, setStatus] = useState('unmatched');
  const [data, setData] = useState(null);
  const [importing, setImporting] = useState(false);
  const [posting, setPosting] = useState(null);
  const reconcile = can('accounting.bank.reconcile');

  const load = useCallback(() => api.get(`/accounting/bank-accounts/${bankId}/transactions`, { query: { status: status || undefined } }).then(setData).catch(() => {}), [bankId, status]);
  useEffect(() => { load(); }, [load]);

  async function act(fn, message) {
    try {
      await fn();
      toast.success(message);
      load();
      onChanged();
    } catch (err) {
      toast.error('That did not work', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {[['unmatched', 'To reconcile'], ['matched', 'Reconciled'], ['', 'All']].map(([k, l]) => <Button key={k} size="sm" variant={status === k ? 'primary' : 'ghost'} onClick={() => setStatus(k)}>{l}</Button>)}
        <div className="flex-1" />
        {reconcile && <Button variant="secondary" icon={Upload} onClick={() => setImporting(true)}>Import statement</Button>}
      </div>
      {!data ? <TableSkeleton rows={5} columns={4} /> : data.data.length === 0 ? (
        <Card><EmptyState icon={CheckCircle2} title={status === 'unmatched' ? 'All reconciled' : 'No statement lines'} description="Import your bank statement to reconcile it." /></Card>
      ) : (
        <Table>
          <THead><tr><TH>Date</TH><TH>Narration</TH><TH align="right">Amount</TH><TH>In the books</TH></tr></THead>
          <TBody>
            {data.data.map((x) => (
              <TR key={x.id}>
                <TD className="whitespace-nowrap">{date(x.txn_date, 'short')}</TD>
                <TD className="max-w-xs truncate">{x.description || '—'}</TD>
                <TD align="right" numeric className={Number(x.amount) > 0 ? 'text-[var(--color-positive-600)]' : ''}>{money(x.amount)}</TD>
                <TD>
                  {x.matched_line_id ? (
                    <span className="flex items-center gap-2 text-sm"><Badge size="sm" tone="positive">{x.matched_entry}</Badge><span className="truncate text-[var(--text-tertiary)]">{x.matched_memo}</span>
                      {reconcile && <Button size="xs" variant="ghost" icon={Unlink} onClick={() => act(() => api.post(`/accounting/bank-transactions/${x.id}/unmatch`, {}), 'Unmatched')} aria-label="Unmatch" />}
                    </span>
                  ) : reconcile ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      {(data.meta.suggestions[x.id] ?? []).map((s) => (
                        <Button key={s.id} size="xs" variant="secondary" icon={Link2} onClick={() => act(() => api.post(`/accounting/bank-transactions/${x.id}/match`, { line_id: s.id }), `Matched to ${s.number}`)}>{s.number} · {date(s.entry_date, 'short')}</Button>
                      ))}
                      <Button size="xs" variant="ghost" icon={Plus} onClick={() => setPosting(x)}>Post it</Button>
                    </span>
                  ) : '—'}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {importing && <ImportModal bankId={bankId} onClose={() => setImporting(false)} onDone={() => { load(); onChanged(); }} />}
      {posting && <PostModal txn={posting} onClose={() => setPosting(null)} onPost={(accountId, memo) => { setPosting(null); act(() => api.post(`/accounting/bank-transactions/${posting.id}/post`, { account_id: accountId, memo }), 'Posted and matched'); }} />}
    </div>
  );
}

function ImportModal({ bankId, onClose, onDone }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = parseStatement(text);
  async function submit() {
    setBusy(true);
    try {
      const r = await api.post(`/accounting/bank-accounts/${bankId}/import`, { rows });
      toast.success(`${r.data.added} lines imported${r.data.skipped ? `, ${r.data.skipped} already there` : ''}`);
      onClose();
      onDone();
    } catch (err) {
      toast.error('Import failed', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Import a statement" size="xl"
      description="Download the statement from net banking as CSV or Excel, and paste the rows here. Columns: date, narration, amount — or date, narration, withdrawal, deposit."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Upload} loading={busy} disabled={!rows.length} onClick={submit}>Import {rows.length || ''} lines</Button></>}>
      <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" data-autofocus
        placeholder={'Date,Narration,Withdrawal,Deposit\n01/09/2026,UPI/Mehta Traders,,11800.00\n02/09/2026,SMS CHARGES,59.00,'} />
      {text && <p className="mt-2 text-sm text-[var(--text-secondary)]">{rows.length} line{rows.length === 1 ? '' : 's'} recognised{rows.length ? ` · net ${money(rows.reduce((s, r) => s + Number(r.amount), 0))}` : ''}.</p>}
    </Modal>
  );
}

function PostModal({ txn, onClose, onPost }) {
  const accounts = useOptions('/accounting/accounts', { active: true, limit: 100 });
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState(txn.description ?? '');
  const incoming = Number(txn.amount) > 0;
  return (
    <Modal open onClose={onClose} title={`Post ${money(Math.abs(Number(txn.amount)))} ${incoming ? 'received' : 'paid'}`}
      description={incoming ? 'Which account does this money come from? (e.g. interest income)' : 'What was it for? (e.g. bank charges)'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!accountId} onClick={() => onPost(accountId, memo)}>Post</Button></>}>
      <div className="space-y-4">
        <Field label="Account">{(p) => <Select {...p} value={accountId} onChange={(e) => setAccountId(e.target.value)} data-autofocus><option value="">Choose…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
        <Field label="Memo">{(p) => <Input {...p} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
        {!accounts.length && <Alert tone="info">Loading accounts…</Alert>}
      </div>
    </Modal>
  );
}
