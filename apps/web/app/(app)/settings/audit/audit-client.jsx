'use client';
import { useEffect, useState } from 'react';
import { ScrollText, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function AuditClient() {
  const { can } = useWorkspace();
  const allowed = can('core.audit.view');
  const [filters, setFilters] = useState({ event_type: '', from: '', to: '' });
  const [applied, setApplied] = useState({});
  const [cursor, setCursor] = useState(null);
  const [history, setHistory] = useState([]);
  const [result, setResult] = useState({ data: [], meta: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!allowed) return;
    let current = true;
    setLoading(true); setError('');
    api.get('/audit', { query: { ...applied, ...(cursor ? { before: cursor } : {}), limit: 30 } })
      .then(data => { if (current) setResult(data); })
      .catch(e => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [allowed, applied, cursor, revision]);
  if (!allowed) return <p>You do not have permission to view the workspace audit log.</p>;
  return <section className="space-y-6 min-w-0">
    <header className="rounded-2xl bg-[#302936] p-6 text-white">
      <div className="flex items-center gap-2 text-sm text-[#d7cbd5]"><ScrollText size={18} /> WORKSPACE HISTORY</div>
      <h2 className="mt-3 text-2xl font-semibold !text-white">A record of what changed.</h2>
      <p className="mt-2 text-sm text-[#d7cbd5]">Published workspace events, preserved in an append-only log.</p>
    </header>
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); setApplied(Object.fromEntries(Object.entries(filters).filter(([,value]) => value))); setCursor(null); setHistory([]); }}>
      <label className="text-sm flex-1 min-w-48">Event type<Input placeholder="e.g. tasks.task.created" value={filters.event_type} onChange={e => setFilters({ ...filters, event_type: e.target.value })} /></label>
      <label className="text-sm">From (UTC)<Input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
      <label className="text-sm">To (UTC)<Input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
      <Button type="submit" disabled={loading}>Apply filters</Button>
      <Button type="button" variant="secondary" aria-label="Refresh audit log" onClick={() => { setCursor(null); setHistory([]); setRevision(v => v + 1); }}><RefreshCw size={16} /></Button>
    </form>
    <p className="text-sm text-[var(--text-secondary)]">Event delivery may take a few seconds. This log covers published events, not every request. Sensitive event payloads are excluded.</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <div aria-busy={loading} className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
      <table className="w-full text-left text-sm"><thead className="bg-[var(--surface-sunken)]"><tr>{['When (UTC)', 'Event', 'Actor', 'Record'].map(x => <th key={x} className="p-3 font-medium">{x}</th>)}</tr></thead>
      <tbody>{!error && result.data.map(row => <tr key={row.event_id} className="border-t border-[var(--border-subtle)]">
        <td className="p-3 whitespace-nowrap">{new Date(row.occurred_at).toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td className="p-3"><span className="font-medium">{row.event_type}</span><p className="mt-1 text-xs text-[var(--text-tertiary)]">{row.event_id}</p></td>
        <td className="p-3 break-all">{row.actor_id ?? 'System'}</td><td className="p-3 break-all">{row.resource_id ?? '—'}</td>
      </tr>)}</tbody></table>
      {loading && <p role="status" className="p-5">Loading events…</p>}
      {!loading && !error && !result.data.length && <p className="p-5">No events match these filters.</p>}
    </div>
    <div className="flex justify-between"><Button variant="secondary" disabled={loading || !history.length} onClick={() => { setCursor(history.at(-1)); setHistory(h => h.slice(0,-1)); }}>Newer</Button>
    <Button variant="secondary" disabled={loading || !!error || !result.meta.next_cursor} onClick={() => { setHistory(h => [...h,cursor]); setCursor(result.meta.next_cursor); }}>Older</Button></div>
  </section>;
}
