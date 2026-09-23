'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock, TrendingUp, TrendingDown, CalendarRange, Fingerprint } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Input, Field } from '@/components/ui/input';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, Alert } from '@/components/ui/primitives';
import { date as fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const TONE = {
  present: 'positive', remote: 'positive', half_day: 'caution',
  on_leave: 'info', absent: 'critical', holiday: 'neutral', weekend: 'neutral',
};

const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

export default function PortalAttendance() {
  const [range, setRange] = useState({ from: monthStart(), to: new Date().toISOString().slice(0, 10) });
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/hr/me/attendance', { query: range });
      setRows(response.data);
      setMeta(response.meta ?? {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your attendance.');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Attendance</h1>
        <p className="mt-1 text-base text-[var(--text-secondary)]">
          Every day you worked, and what it added up to.
        </p>
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Days present" value={meta.days_present ?? 0} icon={Clock} />
        <Figure label="Worked" value={meta.worked_hours ?? '0h 00m'} icon={CalendarRange} />
        <Figure
          label="Overtime"
          value={meta.overtime_hours ?? '0h 00m'}
          icon={TrendingUp}
          tone={meta.overtime_minutes > 0 ? 'positive' : 'neutral'}
        />
        <Figure
          label="Days on leave"
          value={meta.days_leave ?? 0}
          icon={TrendingDown}
          tone={meta.days_absent > 0 ? 'critical' : 'neutral'}
          hint={meta.days_absent ? `${meta.days_absent} absent` : undefined}
        />
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
          <Field label="From" className="w-auto">
            <Input
              type="date" size="sm" value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </Field>
          <Field label="To" className="w-auto">
            <Input
              type="date" size="sm" value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </Field>
        </div>

        {loading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="Nothing recorded for these dates"
            description="Attendance appears here once it is marked, or as soon as you badge in."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Date</TH>
                <TH>Status</TH>
                <TH>In</TH>
                <TH>Out</TH>
                <TH align="right">Worked</TH>
                <TH align="right">Overtime</TH>
                <TH>{''}</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.on_date}>
                  <TD className="whitespace-nowrap font-medium">{fmtDate(row.on_date)}</TD>
                  <TD>
                    <Badge tone={TONE[row.status] ?? 'neutral'} size="sm">
                      {String(row.status).replace('_', ' ')}
                    </Badge>
                  </TD>
                  <TD className="tabular">
                    {row.check_in_at ? fmtDate(row.check_in_at, 'time') : '—'}
                    {row.late_minutes > 0 && (
                      <span className="ml-1 text-xs text-[var(--color-caution-600)]">
                        +{row.late_minutes}m late
                      </span>
                    )}
                  </TD>
                  <TD className="tabular">
                    {row.check_out_at ? fmtDate(row.check_out_at, 'time') : '—'}
                  </TD>
                  <TD align="right" numeric>{row.worked ?? '—'}</TD>
                  <TD align="right" numeric className={cn(
                    row.overtime_minutes > 0 && 'text-[var(--color-positive-600)] dark:text-[var(--color-positive-500)]',
                  )}>
                    {row.overtime ?? '—'}
                  </TD>
                  <TD>
                    {row.source === 'device' && (
                      <span title="Recorded by a punch terminal">
                        <Fingerprint className="size-3.5 text-[var(--text-tertiary)]" />
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Figure({ label, value, icon: Icon, tone = 'neutral', hint }) {
  const tones = {
    neutral: 'text-[var(--text-primary)]',
    positive: 'text-[var(--color-positive-600)] dark:text-[var(--color-positive-500)]',
    critical: 'text-[var(--color-critical-600)] dark:text-[var(--color-critical-500)]',
  };
  return (
    <div className="panel p-4">
      <p className="flex items-center justify-between gap-2 text-sm text-[var(--text-secondary)]">
        <span className="truncate">{label}</span>
        {Icon && <Icon className="size-4 shrink-0 text-[var(--text-disabled)]" strokeWidth={1.75} />}
      </p>
      <p className={cn('metric mt-2 text-2xl font-semibold tabular tracking-[-0.025em]', tones[tone])}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  );
}
