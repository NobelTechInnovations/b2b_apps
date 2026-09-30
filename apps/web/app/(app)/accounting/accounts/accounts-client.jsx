'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { api } from '@/lib/api';
import { money, date } from '@/lib/format';
import { titleCase } from '@/lib/people';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/primitives';
import { ResourcePage } from '@/components/data/resource-page';

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_TONE = { asset: 'brand', liability: 'caution', equity: 'neutral', income: 'positive', expense: 'critical' };

export default function AccountsClient() {
  return (
    <ResourcePage
      title="Chart of accounts"
      description="Every account the books use. The ones marked Automatic are where your apps post; rename or renumber them freely."
      endpoint="/accounting/accounts"
      entity="account"
      permissions={{ create: 'accounting.coa.manage', edit: 'accounting.coa.manage', delete: 'accounting.coa.manage' }}
      searchPlaceholder="Code or name…"
      emptyIcon={BookOpen}
      filters={[{ key: 'type', label: 'Type', options: TYPES.map((t) => ({ value: t, label: titleCase(t) })) }]}
      columns={[
        { key: 'code', label: 'Code', width: '6rem', render: (r) => <span className="font-mono">{r.code}</span> },
        { key: 'name', label: 'Account', render: (r) => <span className="font-medium">{r.name} {r.system_key && <Badge size="sm">Automatic</Badge>} {!r.active && <Badge size="sm">Archived</Badge>}</span> },
        { key: 'type', label: 'Type', render: (r) => <Badge size="sm" tone={TYPE_TONE[r.type]}>{titleCase(r.type)}</Badge> },
        { key: 'balance', label: 'Balance', align: 'right', numeric: true, render: (r) => money(r.balance) },
      ]}
      fields={[
        { key: 'code', label: 'Code', required: true, placeholder: '6150' },
        { key: 'name', label: 'Name', required: true },
        { key: 'type', label: 'Type', type: 'select', required: true, default: 'expense', options: TYPES.map((t) => ({ value: t, label: titleCase(t) })) },
        { key: 'description', label: 'Description', type: 'textarea' },
        { key: 'active', label: 'Active', type: 'checkbox', default: true },
      ]}
      titleOf={(r) => `${r.code} · ${r.name}`}
      subtitleOf={(r) => `${titleCase(r.type)} · balance ${money(r.balance)}`}
      drawerWidth="lg"
      detailItems={() => []}
      detail={(r) => <Ledger account={r} />}
    />
  );
}

function Ledger({ account }) {
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get(`/accounting/accounts/${account.id}/ledger`, { query: { from, to } }).then((r) => setData(r.data)).catch(() => setData(null));
  }, [account.id, from, to]);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="w-40" />
        <span className="text-[var(--text-tertiary)]">to</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className="w-40" />
      </div>
      {data && (
        <table className="w-full text-sm">
          <thead className="text-xs text-[var(--text-tertiary)]">
            <tr><th className="py-1 text-left font-medium">Date</th><th className="text-left font-medium">Entry</th><th className="text-right font-medium">Debit</th><th className="text-right font-medium">Credit</th><th className="text-right font-medium">Balance</th></tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-subtle)]">
            <tr className="text-[var(--text-secondary)]"><td className="py-1.5" colSpan={4}>Opening balance</td><td className="text-right tabular">{money(data.opening_balance)}</td></tr>
            {data.lines.map((l) => (
              <tr key={l.id}>
                <td className="py-1.5 whitespace-nowrap">{date(l.entry_date, 'short')}</td>
                <td className="max-w-[16rem] truncate"><Link href={`/accounting/journal?open=${l.entry_id}`} className="hover:underline">{l.number}</Link> <span className="text-[var(--text-tertiary)]">{l.description || l.memo}</span></td>
                <td className="text-right tabular">{Number(l.debit) ? money(l.debit) : ''}</td>
                <td className="text-right tabular">{Number(l.credit) ? money(l.credit) : ''}</td>
                <td className="text-right tabular">{money(l.balance)}</td>
              </tr>
            ))}
            <tr className="font-medium"><td className="py-1.5" colSpan={4}>Closing balance</td><td className="text-right tabular">{money(data.closing_balance)}</td></tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
