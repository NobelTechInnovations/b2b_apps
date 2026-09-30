'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Wallet, TrendingUp, HandCoins, Receipt, BookPlus, ArrowRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money, date } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { Button } from '@/components/ui/button';
import { StatTile } from '@/components/data/stat-tile';
import { Card, CardHeader, CardBody, PageHeader, Alert, Badge } from '@/components/ui/primitives';

export default function OverviewClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/accounting/overview').then((r) => setData(r.data)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the books.'));
  }, []);
  if (error) return <Alert tone="critical">{error}</Alert>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounting"
        description="Your books, kept by your other apps. Invoices, payments, till sales, goods received, expense claims and payroll post here automatically."
        actions={
          <div className="flex gap-2">
            <Link href="/accounting/reports"><Button variant="secondary">Reports</Button></Link>
            <Can permission="accounting.journal.post"><Link href="/accounting/journal?new=1"><Button variant="primary" icon={BookPlus}>Journal entry</Button></Link></Can>
          </div>
        }
      />
      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Cash and bank" value={data?.cash_position} format="money" loading={!data} icon={Wallet} tone="brand" />
        <StatTile label="Profit this month" value={data?.month_profit} format="money" loading={!data} icon={TrendingUp} tone={Number(data?.month_profit) < 0 ? 'critical' : 'positive'} hint={data ? `${money(data.month_income)} in · ${money(data.month_expense)} out` : undefined} />
        <StatTile label="Customers owe you" value={data?.receivables} format="money" loading={!data} icon={HandCoins} />
        <StatTile label="GST payable (net)" value={data?.gst_payable} format="money" loading={!data} icon={Receipt} hint="Output GST less input credit" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Cash and bank accounts" action={<Link href="/accounting/bank" className="text-sm text-[var(--color-brand-600)]">Reconcile</Link>} />
          <CardBody>
            <ul className="divide-y divide-[var(--border-subtle)] text-sm">
              {(data?.cash_accounts ?? []).map((a) => (
                <li key={a.id} className="flex justify-between py-2"><Link href={`/accounting/accounts?open=${a.id}`} className="hover:underline">{a.code} · {a.name}</Link><span className="tabular">{money(a.balance)}</span></li>
              ))}
            </ul>
            {data && <p className="mt-3 flex justify-between border-t border-[var(--border-subtle)] pt-3 text-sm"><span>Owed to vendors</span><span className="tabular">{money(data.payables)}</span></p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Latest entries" action={<Link href="/accounting/journal" className="inline-flex items-center gap-1 text-sm text-[var(--color-brand-600)]">Journal <ArrowRight className="size-3.5" /></Link>} />
          <CardBody>
            {data?.recent_entries.length === 0 && <p className="py-6 text-center text-sm text-[var(--text-tertiary)]">Nothing posted yet. Issue an invoice or record a sale and it appears here.</p>}
            <ul className="divide-y divide-[var(--border-subtle)] text-sm">
              {(data?.recent_entries ?? []).map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2">
                  <Link href={`/accounting/journal?open=${e.id}`} className="w-20 font-medium hover:underline">{e.number}</Link>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{e.memo}</span>
                  <Badge size="sm">{titleCase(e.source)}</Badge>
                  <span className="w-24 text-right tabular">{money(e.total)}</span>
                  <span className="w-16 text-right text-xs text-[var(--text-tertiary)]">{date(e.entry_date, 'short')}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
