'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, Users, TrendingDown, Hourglass } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { StatTile } from '@/components/data/stat-tile';
import { Card, CardHeader, CardBody, PageHeader, Alert } from '@/components/ui/primitives';

export default function RevenueClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/recurring/revenue').then((r) => setData(r.data)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load.')); }, []);
  const peak = Math.max(1, ...(data?.by_plan ?? []).map((p) => Number(p.mrr)));
  return (
    <div className="space-y-5">
      <PageHeader title="Recurring revenue" description="Monthly recurring revenue normalises every plan to a month: a ₹12,000 yearly plan counts as ₹1,000." />
      {error && <Alert tone="critical">{error}</Alert>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="MRR" value={data?.mrr} format="money" loading={!data} icon={TrendingUp} tone="brand" hint={data ? `ARR ${money(data.arr)}` : undefined} />
        <StatTile label="Paying subscribers" value={data?.active} loading={!data} icon={Users} hint={data ? `${data.trialing} in trial · ${data.paused} paused` : undefined} />
        <StatTile label="New MRR this month" value={data?.new_mrr} format="money" loading={!data} tone="positive" />
        <StatTile label="Churn (30 days)" value={data?.churn_rate} format="percent" loading={!data} icon={TrendingDown} tone={data?.churn_rate > 5 ? 'critical' : 'neutral'} hint={data ? `${money(data.churned_mrr)} MRR lost` : undefined} />
      </div>
      {data?.past_due > 0 && <Alert tone="caution" icon={Hourglass}>{data.past_due} subscription{data.past_due === 1 ? ' is' : 's are'} past due — a renewal invoice is overdue.</Alert>}
      <Card>
        <CardHeader title="MRR by plan" />
        <CardBody className="space-y-3">
          {data?.by_plan.length === 0 && <p className="py-4 text-center text-sm text-[var(--text-tertiary)]">No paying subscribers yet.</p>}
          {(data?.by_plan ?? []).map((p) => (
            <div key={p.plan}>
              <div className="mb-1 flex justify-between text-sm"><span>{p.plan} <span className="text-[var(--text-tertiary)]">· {p.subscribers}</span></span><span className="tabular">{money(p.mrr)}</span></div>
              <div className="h-2 rounded-full bg-[var(--surface-sunken)]"><div className="h-2 rounded-full bg-[var(--color-brand-500)]" style={{ width: `${(Number(p.mrr) / peak) * 100}%` }} /></div>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
