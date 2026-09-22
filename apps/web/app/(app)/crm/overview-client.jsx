'use client';

import Link from 'next/link';
import {
  Target, HandCoins, Sparkles, Gauge, ArrowUpRight, Plus, CalendarClock, CircleDot,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { money, date, relativeTime } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { StatTile } from '@/components/data/stat-tile';
import { Card, CardHeader, CardBody, PageHeader, EmptyState, Badge, Alert } from '@/components/ui/primitives';

const STAGE_BAR = {
  slate: 'bg-[var(--color-ink-400)]',
  sky: 'bg-[#0ea5e9]',
  indigo: 'bg-[var(--color-brand-500)]',
  violet: 'bg-[#8b5cf6]',
  amber: 'bg-[#f59e0b]',
  emerald: 'bg-[#10b981]',
  rose: 'bg-[#f43f5e]',
};

export default function OverviewClient({ overview, error }) {
  if (error) {
    return <Alert tone="critical">We could not load your CRM right now. {error.message}</Alert>;
  }

  const { pipeline, leads, funnel, revenue_trend: trend, upcoming_activities: upcoming, recent_deals: recent } = overview;
  const peak = Math.max(...funnel.map((f) => Number(f.value)), 1);
  const trendPeak = Math.max(...trend.map((t) => Number(t.value)), 1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM"
        description="Your pipeline, your leads and what needs doing today."
        actions={
          <div className="flex gap-2">
            <Can permission="crm.leads.create">
              <Link href="/crm/leads?new=1"><Button variant="secondary" icon={Plus}>New lead</Button></Link>
            </Can>
            <Can permission="crm.pipeline.view">
              <Link href="/crm/pipeline"><Button variant="primary">Open pipeline</Button></Link>
            </Can>
          </div>
        }
      />

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Open pipeline" value={pipeline.open_value} format="money" tone="brand" icon={HandCoins}
          hint={`${pipeline.open_count} open ${pipeline.open_count === 1 ? 'deal' : 'deals'}`}
        />
        <StatTile
          label="Weighted forecast" value={pipeline.weighted_value} format="money" icon={Gauge}
          hint="By stage probability"
        />
        <StatTile
          label="Won this month" value={pipeline.won_this_month} format="money" tone="positive" icon={Target}
          hint={`${pipeline.won_count_month} closed`}
        />
        <StatTile
          label="Lead conversion" value={leads.conversion_rate} format="percent" icon={Sparkles}
          hint={`${leads.total} leads total`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── funnel ──────────────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Sales funnel"
            description="Open deals by stage"
            action={
              <Link href="/crm/pipeline">
                <Button variant="ghost" size="xs" iconRight={ArrowUpRight}>Board</Button>
              </Link>
            }
          />
          <CardBody>
            {funnel.every((stage) => stage.count === 0) ? (
              <EmptyState
                icon={HandCoins}
                title="No open deals yet"
                description="Convert a lead or create a deal to see your funnel here."
                action={
                  <Can permission="crm.deals.create">
                    <Link href="/crm/deals?new=1"><Button variant="secondary" size="sm">Create a deal</Button></Link>
                  </Can>
                }
              />
            ) : (
              <div className="space-y-3">
                {funnel.map((stage) => (
                  <div key={stage.id}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <span className="flex items-center gap-2 text-sm">
                        <span className={cn('size-2 rounded-full', STAGE_BAR[stage.colour] ?? STAGE_BAR.slate)} />
                        {stage.name}
                        <span className="text-xs text-[var(--text-tertiary)] tabular">
                          {stage.count}
                        </span>
                      </span>
                      <span className="text-sm font-medium tabular">{money(stage.value)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                      <div
                        className={cn('h-full rounded-full transition-all duration-700', STAGE_BAR[stage.colour] ?? STAGE_BAR.slate)}
                        style={{ width: `${Math.max((Number(stage.value) / peak) * 100, stage.count > 0 ? 4 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── what needs doing ────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Up next"
            description="Your open activities"
            action={
              <Link href="/crm/activities">
                <Button variant="ghost" size="xs" iconRight={ArrowUpRight}>All</Button>
              </Link>
            }
          />
          <CardBody className="pt-0">
            {upcoming.length === 0 ? (
              <EmptyState icon={CalendarClock} title="Nothing scheduled" description="You are all caught up." />
            ) : (
              <ul className="-mx-1 space-y-0.5">
                {upcoming.map((activity) => {
                  const overdue = activity.due_at && new Date(activity.due_at) < new Date();
                  return (
                    <li key={activity.id}>
                      <Link
                        href="/crm/activities"
                        className="flex items-start gap-2.5 rounded-[var(--radius-md)] px-1 py-2 transition-colors hover:bg-[var(--surface-hover)]"
                      >
                        <CircleDot className={cn('mt-0.5 size-3.5 shrink-0', overdue ? 'text-[var(--color-critical-500)]' : 'text-[var(--text-disabled)]')} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base">{activity.subject}</span>
                          <span className={cn('text-xs', overdue ? 'text-[var(--color-critical-600)]' : 'text-[var(--text-tertiary)]')}>
                            {activity.kind} · {relativeTime(activity.due_at)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── revenue trend ───────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader title="Closed-won revenue" description="Last six months" />
          <CardBody>
            {trend.length === 0 ? (
              <EmptyState icon={Target} title="No closed deals yet" description="Won revenue appears here once you close your first deal." />
            ) : (
              <div className="flex h-44 items-end gap-3">
                {trend.map((month) => (
                  <div key={month.label} className="group flex flex-1 flex-col items-center gap-2">
                    <span className="text-xs font-medium tabular opacity-0 transition-opacity group-hover:opacity-100">
                      {money(month.value, 'INR', { compact: true })}
                    </span>
                    <div
                      className="w-full rounded-t-[var(--radius-sm)] bg-gradient-to-t from-[var(--color-brand-600)] to-[var(--color-brand-400)] transition-all duration-500"
                      style={{ height: `${Math.max((Number(month.value) / trendPeak) * 100, 3)}%` }}
                    />
                    <span className="text-xs text-[var(--text-tertiary)]">{month.label}</span>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── recent activity on deals ────────────────────────────────────── */}
        <Card>
          <CardHeader title="Recently updated" />
          <CardBody className="pt-0">
            {recent.length === 0 ? (
              <EmptyState icon={HandCoins} title="No deals yet" />
            ) : (
              <ul className="-mx-1 space-y-0.5">
                {recent.map((deal) => (
                  <li key={deal.id}>
                    <Link
                      href={`/crm/deals?open=${deal.id}`}
                      className="flex items-start gap-2 rounded-[var(--radius-md)] px-1 py-2 transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', STAGE_BAR[deal.stage_colour] ?? STAGE_BAR.slate)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base">{deal.title}</span>
                        <span className="text-xs text-[var(--text-tertiary)]">
                          {deal.company_name ? `${deal.company_name} · ` : ''}
                          {money(deal.value, deal.currency, { compact: true })}
                        </span>
                      </span>
                      {deal.status !== 'open' && (
                        <Badge size="sm" tone={deal.status === 'won' ? 'positive' : 'critical'}>
                          {deal.status}
                        </Badge>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
