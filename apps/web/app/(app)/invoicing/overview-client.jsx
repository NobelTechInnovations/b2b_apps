'use client';

import Link from 'next/link';
import {
  FileText, IndianRupee, AlertTriangle, TrendingUp, Plus, ArrowUpRight, Receipt,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { money, date, relativeTime } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { StatTile } from '@/components/data/stat-tile';
import { Card, CardHeader, CardBody, EmptyState, PageHeader, Badge, Alert } from '@/components/ui/primitives';

const STATUS_TONE = {
  draft: 'neutral', issued: 'info', partially_paid: 'caution',
  paid: 'positive', overdue: 'critical', void: 'neutral',
};

const BUCKETS = [
  { key: 'not_due', label: 'Not yet due', tone: 'bg-[var(--color-ink-400)]' },
  { key: '1_30', label: '1–30 days', tone: 'bg-[#f59e0b]' },
  { key: '31_60', label: '31–60 days', tone: 'bg-[#f97316]' },
  { key: '61_90', label: '61–90 days', tone: 'bg-[#ef4444]' },
  { key: 'over_90', label: 'Over 90 days', tone: 'bg-[#b91c1c]' },
];

export default function OverviewClient({ summary, recent, ageing, error }) {
  if (error) {
    return <Alert tone="critical">We could not load invoicing right now. {error.message}</Alert>;
  }

  const peak = Math.max(...BUCKETS.map((b) => Number(ageing?.buckets?.[b.key] ?? 0)), 1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoicing"
        description="What you are owed, what has come in, and what is running late."
        actions={
          <Can permission="invoicing.invoices.create">
            <Link href="/invoicing/invoices?new=1">
              <Button variant="primary" icon={Plus}>New invoice</Button>
            </Link>
          </Can>
        }
      />

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Outstanding" value={summary?.outstanding ?? 0} format="money"
          tone="brand" icon={IndianRupee} hint="Issued and unpaid" />
        <StatTile label="Overdue" value={summary?.overdue ?? 0} format="money"
          tone={Number(summary?.overdue ?? 0) > 0 ? 'critical' : 'neutral'}
          icon={AlertTriangle} hint="Past the due date" />
        <StatTile label="Collected this month" value={summary?.collected_this_month ?? 0}
          format="money" tone="positive" icon={TrendingUp} />
        <StatTile label="Drafts" value={summary?.drafts ?? 0} icon={FileText}
          hint="Not yet issued" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── ageing ──────────────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Receivables ageing"
            description={ageing?.as_of ? `As of ${date(ageing.as_of)}` : undefined}
          />
          <CardBody>
            {Number(ageing?.total ?? 0) === 0 ? (
              <EmptyState
                icon={IndianRupee}
                title="Nothing outstanding"
                description="Every issued invoice has been settled."
              />
            ) : (
              <div className="space-y-3">
                {BUCKETS.map((bucket) => {
                  const value = Number(ageing?.buckets?.[bucket.key] ?? 0);
                  return (
                    <div key={bucket.key}>
                      <div className="mb-1.5 flex items-baseline justify-between gap-3">
                        <span className="flex items-center gap-2 text-sm">
                          <span className={cn('size-2 rounded-full', bucket.tone)} />
                          {bucket.label}
                        </span>
                        <span className="text-sm font-medium tabular">{money(value)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                        <div
                          className={cn('h-full rounded-full transition-all duration-700', bucket.tone)}
                          style={{ width: `${Math.max((value / peak) * 100, value > 0 ? 4 : 0)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── who owes the most ───────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Owed by" description="Largest balances" />
          <CardBody className="pt-0">
            {(ageing?.by_customer?.length ?? 0) === 0 ? (
              <EmptyState icon={Receipt} title="Nobody owes you" />
            ) : (
              <ul className="-mx-1 space-y-0.5">
                {ageing.by_customer.slice(0, 6).map((customer) => (
                  <li key={customer.customer_name} className="flex items-center gap-2.5 px-1 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base">{customer.customer_name}</p>
                      <p className="text-xs text-[var(--text-tertiary)]">
                        {customer.invoices} invoice{customer.invoices === 1 ? '' : 's'}
                        {Number(customer.over_90) > 0 && (
                          <span className="text-[var(--color-critical-600)]">
                            {' '}· {money(customer.over_90)} over 90 days
                          </span>
                        )}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular">{money(customer.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent invoices"
          action={
            <Link href="/invoicing/invoices">
              <Button variant="ghost" size="xs" iconRight={ArrowUpRight}>All invoices</Button>
            </Link>
          }
        />
        <CardBody className="pt-0">
          {recent.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No invoices yet"
              description="Raise one directly, or win a deal in CRM and a draft appears here automatically."
            />
          ) : (
            <ul className="-mx-1 space-y-0.5">
              {recent.map((invoice) => (
                <li key={invoice.id}>
                  <Link
                    href={`/invoicing/invoices?open=${invoice.id}`}
                    className="flex items-center gap-3 rounded-[var(--radius-md)] px-1 py-2.5 transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate text-base font-medium">
                        {invoice.number ?? 'Draft'}
                        {invoice.source === 'deal_won' && (
                          <Badge size="sm" tone="brand">From a won deal</Badge>
                        )}
                      </p>
                      <p className="truncate text-xs text-[var(--text-tertiary)]">
                        {invoice.customer_name}
                        {invoice.due_date ? ` · due ${date(invoice.due_date)}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular">
                      {money(invoice.total, invoice.currency)}
                    </span>
                    <Badge size="sm" tone={STATUS_TONE[invoice.status]}>
                      {invoice.status.replace('_', ' ')}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
