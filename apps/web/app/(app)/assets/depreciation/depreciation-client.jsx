'use client';

import { useCallback, useEffect, useState } from 'react';
import { Play, TrendingDown } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { StatTile } from '@/components/data/stat-tile';
import { Card, CardHeader, CardBody, PageHeader, Alert, EmptyState } from '@/components/ui/primitives';

const MONTH = (p) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function DepreciationClient() {
  const toast = useToast();
  const [year, setYear] = useState(new Date().getFullYear());
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get('/assets/depreciation', { query: { year } }).then((r) => setData(r.data)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load.')), [year]);
  useEffect(() => { load(); }, [load]);

  async function run() {
    setBusy(true);
    try {
      const r = await api.post('/assets/depreciation/run', { period });
      toast.success(Number(r.data.posted) ? `${money(r.data.posted)} posted to the ledger` : 'Nothing new to post — this month is already done');
      load();
    } catch (err) {
      toast.error('Could not run depreciation', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  const peak = Math.max(1, ...(data?.months ?? []).map((m) => Number(m.amount)));
  return (
    <div className="space-y-5">
      <PageHeader title="Depreciation" description="Run it once a month. Any month an asset missed is caught up; a month already posted is never posted twice."
        actions={<Can permission="assets.depreciation.run"><div className="flex gap-2"><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44" aria-label="Month" /><Button variant="primary" icon={Play} loading={busy} onClick={run}>Run to {MONTH(period)}</Button></div></Can>} />
      {error && <Alert tone="critical">{error}</Alert>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Assets in use" value={data?.totals.assets} loading={!data} />
        <StatTile label="Cost" value={data?.totals.cost} format="money" loading={!data} />
        <StatTile label="Depreciated so far" value={data?.totals.accumulated} format="money" loading={!data} icon={TrendingDown} />
        <StatTile label="Book value" value={data?.totals.book_value} format="money" loading={!data} tone="brand" />
      </div>
      <Card>
        <CardHeader title={`Posted in ${year}`} action={<Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28" aria-label="Year">{[0, 1, 2, 3].map((n) => new Date().getFullYear() - n).map((y) => <option key={y} value={y}>{y}</option>)}</Select>} />
        <CardBody>
          {data?.months.length === 0 ? <EmptyState icon={TrendingDown} title="Nothing posted this year" description="Run depreciation for a month to post it." /> : (
            <ul className="space-y-2">
              {(data?.months ?? []).map((m) => (
                <li key={m.period} className="flex items-center gap-3 text-sm">
                  <span className="w-36">{MONTH(m.period)}</span>
                  <div className="h-2 flex-1 rounded-full bg-[var(--surface-sunken)]"><div className="h-2 rounded-full bg-[var(--color-brand-500)]" style={{ width: `${(Number(m.amount) / peak) * 100}%` }} /></div>
                  <span className="w-28 text-right tabular">{money(m.amount)}</span>
                  <span className="w-20 text-right text-xs text-[var(--text-tertiary)]">{m.assets} assets</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
