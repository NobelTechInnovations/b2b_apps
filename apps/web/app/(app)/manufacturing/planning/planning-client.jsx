'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, PageHeader, Alert, Skeleton, EmptyState } from '@/components/ui/primitives';

const iso = (d) => d.toISOString().slice(0, 10);

export default function PlanningClient() {
  const [start, setStart] = useState(() => new Date());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const from = iso(start);
    const to = iso(new Date(start.getTime() + 13 * 86_400_000));
    api.get('/manufacturing/planning', { query: { from, to } }).then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the plan.'));
  }, [start]);

  const shift = (days) => setStart((s) => new Date(s.getTime() + days * 86_400_000));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Production planning"
        description="Planned hours per work center per day, against what each can run. Red means over capacity — move an order or add a shift."
        actions={<div className="flex gap-1"><Button size="sm" variant="ghost" icon={ChevronLeft} onClick={() => shift(-7)}>Week</Button><Button size="sm" variant="ghost" onClick={() => setStart(new Date())}>Today</Button><Button size="sm" variant="ghost" iconRight={ChevronRight} onClick={() => shift(7)}>Week</Button></div>}
      />
      {error && <Alert tone="critical">{error}</Alert>}
      {!data ? <Skeleton className="h-48 w-full" /> : data.work_centers.length === 0 ? (
        <Card><EmptyState title="No work centers" description="Add work centers and give recipes their hours to see the load." action={<Link href="/manufacturing/work-centers?new=1"><Button variant="primary">Add a work center</Button></Link>} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-xs text-[var(--text-tertiary)]">
                <th className="px-3 py-2 text-left font-medium">Work center</th>
                {data.days.map((d) => <th key={d} className="px-1 py-2 text-center font-medium">{date(d, 'short')}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.work_centers.map((w) => (
                <tr key={w.id} className="border-b border-[var(--border-subtle)] last:border-0">
                  <td className="px-3 py-2 font-medium">{w.name}<p className="text-xs font-normal text-[var(--text-tertiary)]">{Number(w.hours_per_day)} h/day</p></td>
                  {w.days.map((d) => {
                    const ratio = d.capacity ? d.hours / d.capacity : 0;
                    return (
                      <td key={d.day} className="px-1 py-2 text-center">
                        <span className={cn('inline-block min-w-10 rounded-[var(--radius-sm)] px-1.5 py-1 tabular text-xs',
                          d.hours === 0 ? 'text-[var(--text-disabled)]' : ratio > 1 ? 'bg-[var(--color-critical-50)] font-semibold text-[var(--color-critical-700)]' : ratio > 0.8 ? 'bg-[var(--color-caution-50)] text-[var(--color-caution-700)]' : 'bg-[var(--color-positive-50)] text-[var(--color-positive-700)]')}>
                          {d.hours === 0 ? '·' : `${d.hours}h`}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {data?.orders.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Orders in this window</h3>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {data.orders.map((o) => (
              <li key={o.id}><Link href={`/manufacturing?open=${o.id}`} className="hover:underline">{o.number}</Link> · {o.product_name} × {Number(o.quantity)} <span className="text-[var(--text-tertiary)]">({date(o.start_on, 'short')}–{date(o.end_on, 'short')}, {Math.round(o.hours * 10) / 10}h)</span></li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
