'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Inbox, UserRound, AlarmClock, CheckCircle2, Plus, Timer, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can } from '@/lib/workspace';
import { minutesLabel, titleCase } from '@/lib/people';
import { Button } from '@/components/ui/button';
import { StatTile } from '@/components/data/stat-tile';
import { Card, CardHeader, CardBody, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';

const PRIORITY_BAR = {
  urgent: 'bg-[var(--color-critical-500)]', high: 'bg-[var(--color-caution-500)]',
  normal: 'bg-[var(--color-brand-500)]', low: 'bg-[var(--color-ink-400)]',
};

export default function OverviewClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/helpdesk/overview')
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the helpdesk.'));
  }, []);

  if (error) return <Alert tone="critical">{error}</Alert>;

  const priorities = ['urgent', 'high', 'normal', 'low'].map((p) => ({
    priority: p, n: data?.by_priority.find((row) => row.priority === p)?.n ?? 0,
  }));
  const peak = Math.max(1, ...priorities.map((p) => p.n));
  const channelPeak = Math.max(1, ...(data?.by_channel ?? []).map((c) => c.n));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Helpdesk"
        description="Every customer question in one queue, with clocks that keep promises visible."
        actions={
          <div className="flex gap-2">
            <Link href="/helpdesk/tickets?assignee=me"><Button variant="secondary" icon={UserRound}>My tickets</Button></Link>
            <Can permission="helpdesk.tickets.create">
              <Link href="/helpdesk/tickets?new=1"><Button variant="primary" icon={Plus}>New ticket</Button></Link>
            </Can>
          </div>
        }
      />

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Active tickets" value={data?.active} loading={!data} icon={Inbox} tone="brand"
          hint={data ? `${data.open} open · ${data.pending} pending · ${data.on_hold} on hold` : undefined} />
        <StatTile label="Assigned to me" value={data?.mine} loading={!data} icon={UserRound}
          hint={data ? `${data.unassigned} waiting for an owner` : undefined} />
        <StatTile label="SLA breached" value={data?.breached} loading={!data} icon={AlarmClock}
          tone={data?.breached ? 'critical' : 'neutral'} hint="Past a response or resolution deadline" />
        <StatTile label="Resolved this week" value={data?.resolved_7d} loading={!data} icon={CheckCircle2} tone="positive"
          hint={data ? `${data.created_7d} new this week` : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Service levels" description="Last 30 days" />
          <CardBody className="space-y-4">
            {!data ? <Skeleton className="h-16 w-full" /> : (
              <>
                <Metric icon={Timer} label="Average first response" value={minutesLabel(data.avg_first_response_minutes)} />
                <Metric icon={ShieldCheck} label="Resolved within SLA"
                  value={data.sla_met_percent === null ? '—' : `${data.sla_met_percent}%`} />
                <Can permission="helpdesk.sla.manage">
                  <Link href="/helpdesk/sla" className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)]">
                    Adjust SLA targets <ArrowUpRight className="size-3.5" />
                  </Link>
                </Can>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Active by priority" />
          <CardBody className="space-y-3">
            {priorities.map((p) => (
              <Link key={p.priority} href={`/helpdesk/tickets?priority=${p.priority}`} className="block">
                <div className="mb-1 flex justify-between text-sm">
                  <span>{titleCase(p.priority)}</span>
                  <span className="tabular text-[var(--text-secondary)]">{p.n}</span>
                </div>
                <div className="h-2 rounded-full bg-[var(--surface-sunken)]">
                  <div className={`h-2 rounded-full ${PRIORITY_BAR[p.priority]}`} style={{ width: `${(p.n / peak) * 100}%` }} />
                </div>
              </Link>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Where tickets come from" description="Last 30 days" />
          <CardBody className="space-y-3">
            {data?.by_channel.length === 0 && (
              <p className="py-4 text-center text-sm text-[var(--text-tertiary)]">No tickets in the last 30 days.</p>
            )}
            {(data?.by_channel ?? []).map((c) => (
              <div key={c.channel}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{titleCase(c.channel)}</span>
                  <span className="tabular text-[var(--text-secondary)]">{c.n}</span>
                </div>
                <div className="h-2 rounded-full bg-[var(--surface-sunken)]">
                  <div className="h-2 rounded-full bg-[#0ea5e9]" style={{ width: `${(c.n / channelPeak) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-9 items-center justify-center rounded-[var(--radius-md)] bg-[var(--surface-sunken)]">
        <Icon className="size-4 text-[var(--text-secondary)]" />
      </span>
      <div>
        <p className="text-xs text-[var(--text-tertiary)]">{label}</p>
        <p className="metric text-lg font-semibold">{value}</p>
      </div>
    </div>
  );
}
