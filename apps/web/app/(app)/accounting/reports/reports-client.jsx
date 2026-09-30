'use client';

import { useEffect, useState } from 'react';
import { Download, Printer, CheckCircle2, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, date } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';

const today = () => new Date().toISOString().slice(0, 10);
const fyStart = () => {
  const d = new Date();
  const year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // Indian financial year: April
  return `${year}-04-01`;
};

function download(name, rows) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob([`\uFEFF${rows.map((r) => r.map(cell).join(',')).join('\n')}`], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function ReportsClient() {
  const { can } = useWorkspace();
  const [tab, setTab] = useState('pl');
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(today());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    const path = { pl: '/accounting/reports/profit-loss', bs: '/accounting/reports/balance-sheet', tb: '/accounting/reports/trial-balance' }[tab];
    const query = tab === 'pl' ? { from, to } : { as_of: to };
    api.get(path, { query }).then((r) => setData(r.data)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the report.'));
  }, [tab, from, to]);

  function exportCsv() {
    if (!data) return;
    if (tab === 'pl') download(`profit-and-loss-${from}-to-${to}.csv`, [['Section', 'Code', 'Account', 'Amount'], ...data.income.map((r) => ['Income', r.code, r.name, r.balance]), ['', '', 'Total income', data.total_income], ...data.expense.map((r) => ['Expense', r.code, r.name, r.balance]), ['', '', 'Total expenses', data.total_expense], ['', '', 'Net profit', data.net_profit]]);
    if (tab === 'bs') download(`balance-sheet-${to}.csv`, [['Section', 'Code', 'Account', 'Amount'], ...data.assets.map((r) => ['Assets', r.code, r.name, r.balance]), ['', '', 'Total assets', data.total_assets], ...data.liabilities.map((r) => ['Liabilities', r.code, r.name, r.balance]), ...data.equity.map((r) => ['Equity', r.code, r.name, r.balance]), ['Equity', '', 'Current earnings', data.current_earnings], ['', '', 'Total liabilities and equity', (Number(data.total_liabilities) + Number(data.total_equity)).toFixed(2)]]);
    if (tab === 'tb') download(`trial-balance-${to}.csv`, [['Code', 'Account', 'Debit', 'Credit'], ...data.lines.map((l) => [l.code, l.name, l.debit, l.credit]), ['', 'Total', data.total_debit, data.total_credit]]);
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Reports" description="Straight from the ledger, as of the dates you choose."
        actions={<div className="flex gap-2">
          {can('accounting.reports.export') && <Button variant="secondary" icon={Download} onClick={exportCsv} disabled={!data}>CSV</Button>}
          <Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print</Button>
        </div>} />
      <div className="flex flex-wrap items-center gap-2">
        {[['pl', 'Profit & loss'], ['bs', 'Balance sheet'], ['tb', 'Trial balance']].map(([k, l]) => <Button key={k} size="sm" variant={tab === k ? 'primary' : 'ghost'} onClick={() => setTab(k)}>{l}</Button>)}
        <div className="flex-1" />
        {tab === 'pl' && <><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From" /><span className="text-[var(--text-tertiary)]">to</span></>}
        {tab !== 'pl' && <span className="text-sm text-[var(--text-tertiary)]">As of</span>}
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To" />
      </div>
      {error && <Alert tone="critical">{error}</Alert>}
      {!data ? <Skeleton className="h-64 w-full" /> : (
        <Card className="mx-auto max-w-3xl p-6 print:shadow-none">
          {tab === 'pl' && (
            <Statement title={`Profit and loss · ${date(from)} – ${date(to)}`} sections={[
              { title: 'Income', rows: data.income, total: data.total_income, label: 'Total income' },
              { title: 'Expenses', rows: data.expense, total: data.total_expense, label: 'Total expenses' },
            ]} result={{ label: Number(data.net_profit) >= 0 ? 'Net profit' : 'Net loss', value: data.net_profit }} />
          )}
          {tab === 'bs' && (
            <>
              <Statement title={`Balance sheet · as of ${date(to)}`} sections={[
                { title: 'Assets', rows: data.assets, total: data.total_assets, label: 'Total assets' },
                { title: 'Liabilities', rows: data.liabilities, total: data.total_liabilities, label: 'Total liabilities' },
                { title: 'Equity', rows: [...data.equity, { id: 'earnings', code: '', name: 'Current earnings (not yet closed)', balance: data.current_earnings }], total: data.total_equity, label: 'Total equity' },
              ]} result={{ label: 'Liabilities + equity', value: (Number(data.total_liabilities) + Number(data.total_equity)).toFixed(2) }} />
              <Check ok={data.balanced} yes="Assets equal liabilities plus equity." no="The balance sheet does not balance — check for entries posted outside the ledger rules." />
            </>
          )}
          {tab === 'tb' && (
            <>
              <h2 className="mb-4 text-lg font-semibold">Trial balance · as of {date(to)}</h2>
              <table className="w-full text-sm">
                <thead className="text-xs text-[var(--text-tertiary)]"><tr><th className="py-1 text-left font-medium">Account</th><th className="text-right font-medium">Debit</th><th className="text-right font-medium">Credit</th></tr></thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {data.lines.map((l) => <tr key={l.id}><td className="py-1.5"><span className="font-mono text-xs text-[var(--text-tertiary)]">{l.code}</span> {l.name}</td><td className="text-right tabular">{Number(l.debit) ? money(l.debit) : ''}</td><td className="text-right tabular">{Number(l.credit) ? money(l.credit) : ''}</td></tr>)}
                  <tr className="font-semibold"><td className="py-2">Total</td><td className="text-right tabular">{money(data.total_debit)}</td><td className="text-right tabular">{money(data.total_credit)}</td></tr>
                </tbody>
              </table>
              <Check ok={data.balanced} yes="Debits equal credits." no="Debits and credits differ." />
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function Statement({ title, sections, result }) {
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {sections.map((s) => (
        <section key={s.title} className="mb-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{s.title}</h3>
          <ul className="divide-y divide-[var(--border-subtle)] text-sm">
            {s.rows.length === 0 && <li className="py-1.5 text-[var(--text-tertiary)]">Nothing in this period.</li>}
            {s.rows.map((r) => <li key={r.id} className="flex justify-between py-1.5"><span><span className="font-mono text-xs text-[var(--text-tertiary)]">{r.code}</span> {r.name}</span><span className="tabular">{money(r.balance)}</span></li>)}
            <li className="flex justify-between py-1.5 font-medium"><span>{s.label}</span><span className="tabular">{money(s.total)}</span></li>
          </ul>
        </section>
      ))}
      <p className={cn('flex justify-between border-t-2 border-[var(--border-strong)] pt-2 text-md font-semibold', Number(result.value) < 0 && 'text-[var(--color-critical-600)]')}><span>{result.label}</span><span className="tabular">{money(result.value)}</span></p>
    </div>
  );
}

const Check = ({ ok, yes, no }) => (
  <p className={cn('mt-4 flex items-center gap-1.5 text-sm', ok ? 'text-[var(--color-positive-600)]' : 'text-[var(--color-critical-600)]')}>
    {ok ? <CheckCircle2 className="size-4" /> : <TriangleAlert className="size-4" />}{ok ? yes : no}
  </p>
);
