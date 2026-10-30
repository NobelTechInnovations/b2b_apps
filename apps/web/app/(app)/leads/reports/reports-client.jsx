'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date as fmtDate } from '@/lib/format';
import { Input, Select } from '@/components/ui/input';
import { Pagination } from '@/components/data/list-shell';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { Alert, Avatar, Badge, Card, CardHeader, CardBody, PageHeader, Skeleton } from '@/components/ui/primitives';
import { Chip, OUTCOME_LABEL, OUTCOME_TONE, TZ, formName, useLeadsMeta } from '@/components/leads/lead-kit';

/** A day in the viewer's time zone, as YYYY-MM-DD. */
const dayOf = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
};
const monthStart = () => `${dayOf().slice(0, 8)}01`;

const RANGES = [
  { key: 'today', label: 'Today', compare: 'vs yesterday', range: () => [dayOf(), dayOf()] },
  { key: 'yesterday', label: 'Yesterday', compare: 'vs the day before', range: () => [dayOf(-1), dayOf(-1)] },
  { key: 'week', label: 'Last 7 days', compare: 'vs the 7 days before', range: () => [dayOf(-6), dayOf()] },
  { key: 'month', label: 'This month', compare: 'vs the same days before', range: () => [monthStart(), dayOf()] },
  { key: '30', label: 'Last 30 days', compare: 'vs the 30 days before', range: () => [dayOf(-29), dayOf()] },
  { key: 'custom', label: 'Custom', compare: 'vs the same length before' },
];

const METRICS = [
  { key: 'new_leads', label: 'New leads', hint: 'Leads added' },
  { key: 'calls', label: 'Calls made', hint: 'Calls logged' },
  { key: 'leads_called', label: 'Leads called', hint: 'Different leads called' },
  { key: 'connected', label: 'Reached', hint: 'Calls where they picked up' },
  { key: 'interested', label: 'Interested', hint: 'Calls marked interested' },
  { key: 'followups_done', label: 'Follow-ups done', hint: 'Booked follow-ups completed' },
  { key: 'followups_booked', label: 'Follow-ups booked', hint: 'New follow-ups scheduled' },
  { key: 'won', label: 'Won', hint: 'Moved to a won stage' },
  { key: 'lost', label: 'Lost', hint: 'Moved to a lost stage' },
];

export default function ReportsClient() {
  const { meta } = useLeadsMeta();
  const [rangeKey, setRangeKey] = useState('today');
  const [custom, setCustom] = useState([dayOf(-6), dayOf()]);
  const [person, setPerson] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [logType, setLogType] = useState('call');
  const [logPage, setLogPage] = useState(1);
  const [log, setLog] = useState(null);

  const range = rangeKey === 'custom' ? custom : RANGES.find((r) => r.key === rangeKey).range();
  const query = useMemo(() => ({ from: range[0], to: range[1], tz: TZ, user_id: person || undefined }), [range[0], range[1], person]);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport((await api.get('/leads/reports', { query })).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the report.');
    }
  }, [query]);
  useEffect(() => { setReport(null); load(); }, [load]);
  useEffect(() => { setLogPage(1); }, [query, logType]);
  useEffect(() => {
    let live = true;
    setLog(null);
    api.get('/leads/reports/activity', { query: { ...query, type: logType, page: logPage, limit: 25 } })
      .then((r) => { if (live) setLog(r); })
      .catch(() => { if (live) setLog({ data: [], meta: null }); });
    return () => { live = false; };
  }, [query, logType, logPage]);

  const compare = RANGES.find((r) => r.key === rangeKey).compare;
  const s = report?.summary;
  const single = range[0] === range[1];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Lead reports"
        description={meta?.sees_all ? 'Calls, follow-ups and new leads for the whole team — compared with the period before.' : 'Your calls, follow-ups and new leads — compared with the period before.'}
      />

      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => <Chip key={r.key} active={rangeKey === r.key} onClick={() => setRangeKey(r.key)}>{r.label}</Chip>)}
        {rangeKey === 'custom' && (
          <div className="flex items-center gap-1.5">
            <Input type="date" value={custom[0]} max={custom[1]} onChange={(e) => setCustom([e.target.value || custom[0], custom[1]])} className="w-auto" aria-label="From" />
            <span className="text-sm text-[var(--text-tertiary)]">to</span>
            <Input type="date" value={custom[1]} min={custom[0]} max={dayOf()} onChange={(e) => setCustom([custom[0], e.target.value || custom[1]])} className="w-auto" aria-label="To" />
          </div>
        )}
        <div className="flex-1" />
        {meta?.sees_all && (
          <Select value={person} onChange={(e) => setPerson(e.target.value)} className="w-auto" aria-label="Person">
            <option value="">Everyone</option>
            {(meta.team ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
          </Select>
        )}
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      {/* The numbers, each against the period before. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {METRICS.map((m) => (
          <Card key={m.key} className="px-4 py-3" title={m.hint}>
            <p className="text-xs font-medium text-[var(--text-secondary)]">{m.label}</p>
            {s ? (
              <>
                <p className="tabular mt-1 text-2xl font-semibold">{s[m.key].value}</p>
                <Delta value={s[m.key].value} previous={s[m.key].previous} compare={compare} />
              </>
            ) : <Skeleton className="mt-2 h-10" />}
          </Card>
        ))}
        <Card className="px-4 py-3">
          <p className="text-xs font-medium text-[var(--text-secondary)]">Overdue now</p>
          {s ? (
            <>
              <p className={cn('tabular mt-1 text-2xl font-semibold', s.overdue_now > 0 && 'text-[var(--color-critical-600)]')}>{s.overdue_now}</p>
              <Link href="/leads?view=overdue" className="text-xs text-[var(--text-brand)]">Open the list →</Link>
            </>
          ) : <Skeleton className="mt-2 h-10" />}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title={meta?.sees_all && !person ? 'By person' : 'Your work'} description={`${fmtDate(range[0])}${single ? '' : ` – ${fmtDate(range[1])}`}`} />
          {!report ? <CardBody><Skeleton className="h-32" /></CardBody> : report.people.length === 0 ? (
            <CardBody><p className="text-sm text-[var(--text-secondary)]">No calls or follow-ups in this period.</p></CardBody>
          ) : (
            <Table>
              <THead><tr><TH>Person</TH><TH align="right">Calls</TH><TH align="right">Leads called</TH><TH align="right">Reached</TH><TH align="right">Interested</TH><TH align="right">Follow-ups done</TH><TH align="right">New leads</TH></tr></THead>
              <TBody>
                {report.people.map((p) => (
                  <TR key={p.user_id} onClick={meta?.sees_all ? () => setPerson(p.user_id) : undefined}>
                    <TD><span className="flex items-center gap-2"><Avatar name={p.name} size="xs" />{p.name}</span></TD>
                    <TD align="right" className="tabular font-medium">{p.calls}</TD>
                    <TD align="right" className="tabular">{p.leads_called}</TD>
                    <TD align="right" className="tabular">{p.connected}</TD>
                    <TD align="right" className="tabular">{p.interested}</TD>
                    <TD align="right" className="tabular">{p.followups_done}</TD>
                    <TD align="right" className="tabular">{p.new_leads}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Call results" />
          <CardBody className="space-y-2">
            {!report ? <Skeleton className="h-24" /> : report.outcomes.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">No calls in this period.</p>
              : report.outcomes.map((o) => (
                <div key={o.outcome ?? 'none'} className="flex items-center justify-between gap-2 text-sm">
                  <Badge size="sm" tone={OUTCOME_TONE[o.outcome] ?? 'neutral'}>{OUTCOME_LABEL[o.outcome] ?? o.outcome ?? 'Not recorded'}</Badge>
                  <span className="tabular font-medium">{o.count}</span>
                </div>
              ))}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="New leads by form / source" description={compare} />
          {!report ? <CardBody><Skeleton className="h-24" /></CardBody> : report.sources.length === 0 ? (
            <CardBody><p className="text-sm text-[var(--text-secondary)]">No new leads in either period.</p></CardBody>
          ) : (
            <Table>
              <THead><tr><TH>Form / source</TH><TH align="right">This period</TH><TH align="right">Before</TH><TH align="right">Change</TH></tr></THead>
              <TBody>
                {report.sources.map((row) => (
                  <TR key={row.key}>
                    <TD className="max-w-[16rem] truncate" title={formName({ value: row.key, named: row.named, source: row.source })}>{formName({ value: row.key, named: row.named, source: row.source })}</TD>
                    <TD align="right" className="tabular font-medium">{row.count}</TD>
                    <TD align="right" className="tabular text-[var(--text-secondary)]">{row.prev}</TD>
                    <TD align="right"><Delta value={row.count} previous={row.prev} bare /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        {!single && (
          <Card>
            <CardHeader title="Day by day" />
            {!report ? <CardBody><Skeleton className="h-24" /></CardBody> : (
              <div className="max-h-96 overflow-y-auto">
                <Table>
                  <THead><tr><TH>Day</TH><TH align="right">New leads</TH><TH align="right">Calls</TH><TH align="right">Follow-ups done</TH></tr></THead>
                  <TBody>
                    {[...report.days].reverse().map((d) => (
                      <TR key={d.day}>
                        <TD>{new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d.day}T12:00:00`))}</TD>
                        <TD align="right" className="tabular">{d.new_leads}</TD>
                        <TD align="right" className="tabular">{d.calls}</TD>
                        <TD align="right" className="tabular">{d.followups_done}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* Who called which lead, and what happened. */}
      <Card>
        <CardHeader
          title="Who called whom"
          description="Every call and follow-up in this period, newest first."
          action={(
            <div className="flex gap-1.5">
              {[['call', 'Calls'], ['followup', 'Follow-ups'], ['all', 'Everything']].map(([key, label]) => (
                <Chip key={key} active={logType === key} onClick={() => setLogType(key)}>{label}</Chip>
              ))}
            </div>
          )}
        />
        {!log ? <CardBody><Skeleton className="h-32" /></CardBody> : log.data.length === 0 ? (
          <CardBody><p className="text-sm text-[var(--text-secondary)]">Nothing logged in this period.</p></CardBody>
        ) : (
          <>
            <Table>
              <THead><tr><TH>When</TH><TH>Who</TH><TH>Lead</TH><TH>What</TH><TH>Note</TH></tr></THead>
              <TBody>
                {log.data.map((a) => (
                  <TR key={a.id}>
                    <TD className="whitespace-nowrap text-sm text-[var(--text-secondary)]">{fmtDate(a.completed_at, single ? 'time' : 'datetime')}</TD>
                    <TD className="whitespace-nowrap text-sm">{a.by ?? '—'}</TD>
                    <TD>
                      <Link href={`/leads?open=${a.lead_id}`} className="font-medium text-[var(--text-brand)]">{a.lead_name || a.phone || 'Lead'}</Link>
                      {a.phone && <p className="text-xs text-[var(--text-tertiary)]">{a.phone}</p>}
                    </TD>
                    <TD>
                      {a.kind === 'call' && !a.due_at && OUTCOME_LABEL[a.outcome]
                        ? <Badge size="sm" tone={OUTCOME_TONE[a.outcome]}>{OUTCOME_LABEL[a.outcome]}</Badge>
                        : <span className="text-sm">{a.subject}</span>}
                    </TD>
                    <TD className="max-w-md truncate text-sm text-[var(--text-secondary)]" title={a.body ?? undefined}>{a.body ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination meta={log.meta} onPage={setLogPage} className="px-4 pb-3" />
          </>
        )}
      </Card>
    </div>
  );
}

/** Up, down or level against the period before. */
function Delta({ value, previous, compare, bare }) {
  const change = value - previous;
  const Icon = change > 0 ? ArrowUpRight : change < 0 ? ArrowDownRight : Minus;
  const pct = previous > 0 ? Math.round((change / previous) * 100) : null;
  const tone = change > 0 ? 'text-[var(--color-positive-600)]' : change < 0 ? 'text-[var(--color-critical-600)]' : 'text-[var(--text-tertiary)]';
  return (
    <p className={cn('mt-0.5 flex items-center gap-1 text-xs', bare && 'justify-end')}>
      <span className={cn('flex items-center gap-0.5 font-medium', tone)}>
        <Icon className="size-3.5" />{change > 0 ? '+' : ''}{change}{pct !== null && change !== 0 ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}
      </span>
      {!bare && <span className="text-[var(--text-tertiary)]">{previous} {compare}</span>}
    </p>
  );
}
