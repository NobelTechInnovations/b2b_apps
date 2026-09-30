'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BookPlus, Plus, Trash2, Undo2, NotebookText } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, date } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { useOptions } from '@/components/data/resource-page';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const SOURCES = ['manual', 'invoice', 'payment', 'pos', 'pos_refund', 'store', 'purchase', 'expense', 'payroll', 'depreciation', 'asset', 'bank', 'reversal'];
const paise = (v) => Math.round(Number(v || 0) * 100);

export default function JournalClient() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useWorkspace();
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
    if (params.get('open')) setOpenId(params.get('open'));
  }, [params]);

  const load = useCallback(() => {
    api.get('/accounting/journal', { query: { ...filters, q: search || undefined, page } }).then((r) => { setRows(r.data); setMeta(r.meta); })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the journal.'));
  }, [filters, search, page]);
  useEffect(() => { const t = setTimeout(load, search ? 250 : 0); return () => clearTimeout(t); }, [load, search]);
  const clear = () => { if (params.get('new') || params.get('open')) router.replace('/accounting/journal'); };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Journal"
        description="Every entry in the books, automatic or by hand. Entries are never edited or deleted — a mistake is reversed, so the trail stays complete."
        actions={<Can permission="accounting.journal.post"><Button variant="primary" icon={BookPlus} onClick={() => setCreating(true)}>New entry</Button></Can>}
      />
      <ListToolbar search={search} onSearch={(v) => { setSearch(v); setPage(1); }} searchPlaceholder="Entry number or memo…"
        filters={[{ key: 'source', label: 'Source', options: SOURCES.map((s) => ({ value: s, label: titleCase(s) })) }]}
        values={filters} onFilter={(k, v) => { setFilters(v === undefined ? {} : { [k]: v }); setPage(1); }} onClear={() => setFilters({})} />
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={8} columns={5} /> : rows.length === 0 ? (
        <Card><EmptyState icon={NotebookText} title="No entries" description="Entries appear as your apps post, or when you add one by hand." action={can('accounting.journal.post') && <Button variant="primary" icon={BookPlus} onClick={() => setCreating(true)}>New entry</Button>} /></Card>
      ) : (
        <>
          <Table>
            <THead><tr><TH>Entry</TH><TH>Date</TH><TH>Memo</TH><TH>Source</TH><TH align="right">Amount</TH></tr></THead>
            <TBody>
              {rows.map((e) => (
                <TR key={e.id} onClick={() => setOpenId(e.id)}>
                  <TD className="font-medium">{e.number}</TD>
                  <TD className="text-[var(--text-secondary)]">{date(e.entry_date)}</TD>
                  <TD className="max-w-md truncate">{e.memo} {e.reversed_by_id && <Badge size="sm" tone="caution">Reversed</Badge>}</TD>
                  <TD><Badge size="sm">{titleCase(e.source)}</Badge></TD>
                  <TD align="right" numeric>{money(e.total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}
      {creating && <EntryForm onClose={() => { setCreating(false); clear(); }} onSaved={(e) => { load(); setOpenId(e.id); }} />}
      {openId && <EntryDrawer id={openId} onClose={() => { setOpenId(null); clear(); }} onChanged={load} />}
    </div>
  );
}

function EntryForm({ onClose, onSaved }) {
  const toast = useToast();
  const accounts = useOptions('/accounting/accounts', { active: true, limit: 100 });
  const [memo, setMemo] = useState('');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState([{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const debit = lines.reduce((s, l) => s + paise(l.debit), 0);
  const credit = lines.reduce((s, l) => s + paise(l.credit), 0);
  const diff = debit - credit;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/accounting/journal', {
        memo, entry_date: entryDate,
        lines: lines.filter((l) => l.account_id && (paise(l.debit) || paise(l.credit))).map((l) => ({
          account_id: l.account_id, debit: paise(l.debit) ? (paise(l.debit) / 100).toFixed(2) : undefined, credit: paise(l.credit) ? (paise(l.credit) / 100).toFixed(2) : undefined, description: l.description,
        })),
      });
      toast.success(`${r.data.number} posted`);
      onClose();
      onSaved(r.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not post.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New journal entry" size="full"
      description="Opening balances, rent, loan repayments, corrections — anything the apps do not post for you."
      footer={<><span className={cn('mr-auto text-sm', diff === 0 ? 'text-[var(--color-positive-600)]' : 'text-[var(--color-critical-600)]')}>{diff === 0 ? (debit ? 'Balanced' : '') : `Off by ${money(Math.abs(diff) / 100)}`}</span><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!memo.trim() || diff !== 0 || !debit} onClick={submit}>Post entry</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label="Memo" required>{(p) => <Input {...p} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="September office rent" data-autofocus />}</Field>
          <Field label="Date">{(p) => <Input {...p} type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />}</Field>
        </div>
        <div className="space-y-2">
          <div className="hidden gap-2 px-1 text-xs font-medium text-[var(--text-tertiary)] sm:flex"><span className="flex-1">Account</span><span className="w-48">Description</span><span className="w-32 text-right">Debit</span><span className="w-32 text-right">Credit</span><span className="w-8" /></div>
          {lines.map((l, i) => (
            <div key={i} className="flex flex-wrap gap-2 sm:flex-nowrap">
              <Select value={l.account_id} onChange={(e) => set(i, { account_id: e.target.value })} className="min-w-[14rem] flex-1" aria-label="Account">
                <option value="">Choose account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </Select>
              <Input className="w-48" value={l.description ?? ''} onChange={(e) => set(i, { description: e.target.value })} placeholder="Optional" aria-label="Description" />
              <Input className="w-32 text-right" type="number" min="0" step="0.01" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} aria-label="Debit" />
              <Input className="w-32 text-right" type="number" min="0" step="0.01" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} aria-label="Credit" />
              <Button variant="ghost" size="icon-sm" icon={Trash2} aria-label="Remove" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setLines((ls) => [...ls, { account_id: '', debit: '', credit: '' }])}>Add line</Button>
            <p className="text-sm tabular">Debits {money(debit / 100)} · Credits {money(credit / 100)}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function EntryDrawer({ id, onClose, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [entry, setEntry] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => api.get(`/accounting/journal/${id}`).then((r) => setEntry(r.data)).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);

  async function reverse() {
    try {
      const r = await api.post(`/accounting/journal/${id}/reverse`, {});
      toast.success(`Reversed by ${r.data.number}`);
      setConfirm(false);
      load();
      onChanged();
    } catch (err) {
      toast.error('Could not reverse', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const e = entry;
  return (
    <Drawer open onClose={onClose} width="lg" title={e ? `${e.number} · ${e.memo}` : 'Loading…'} subtitle={e ? `${date(e.entry_date)} · ${titleCase(e.source)}` : undefined}
      badge={e?.reversed_by_id ? <Badge size="sm" tone="caution">Reversed</Badge> : e?.reverses_id ? <Badge size="sm">Reversal</Badge> : null}
      footer={e && can('accounting.journal.post') && !e.reversed_by_id && !e.reverses_id && <><div className="flex-1" /><Button variant="secondary" icon={Undo2} onClick={() => setConfirm(true)}>Reverse</Button></>}>
      {e && (
        <Table>
          <THead><tr><TH>Account</TH><TH>Description</TH><TH align="right">Debit</TH><TH align="right">Credit</TH></tr></THead>
          <TBody>
            {e.lines.map((l) => (
              <TR key={l.id}>
                <TD><span className="font-mono text-xs text-[var(--text-tertiary)]">{l.code}</span> {l.account_name}</TD>
                <TD className="text-[var(--text-secondary)]">{l.description || '—'}</TD>
                <TD align="right" numeric>{Number(l.debit) ? money(l.debit) : ''}</TD>
                <TD align="right" numeric>{Number(l.credit) ? money(l.credit) : ''}</TD>
              </TR>
            ))}
            <TR><TD className="font-medium">Total</TD><TD /><TD align="right" numeric className="font-medium">{money(e.total)}</TD><TD align="right" numeric className="font-medium">{money(e.total)}</TD></TR>
          </TBody>
        </Table>
      )}
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={reverse} title="Reverse this entry?" description="A mirror-image entry is posted today. The original stays in the books." confirmLabel="Reverse" />
    </Drawer>
  );
}
