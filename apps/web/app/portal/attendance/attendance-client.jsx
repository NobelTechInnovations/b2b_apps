'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Clock, TrendingUp, TrendingDown, CalendarRange, Fingerprint, PenLine, Clock3, CheckCircle2, XCircle,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
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
  const [requests, setRequests] = useState([]);
  const [requesting, setRequesting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [response, pending] = await Promise.all([
        api.get('/hr/me/attendance', { query: range }),
        api.get('/hr/me/attendance/requests').catch(() => ({ data: [] })),
      ]);
      setRows(response.data);
      setRequests(pending.data);
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Attendance</h1>
          <p className="mt-1 text-base text-[var(--text-secondary)]">
            Every day you worked, and what it added up to.
          </p>
        </div>
        <Button variant="secondary" icon={PenLine} onClick={() => setRequesting({})}>
          Request a correction
        </Button>
      </div>

      <RequestList requests={requests} onWithdrawn={load} />

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
                    <div className="flex items-center justify-end gap-2">
                      {row.source === 'device' && (
                        <span title="Recorded by a punch terminal">
                          <Fingerprint className="size-3.5 text-[var(--text-tertiary)]" />
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setRequesting({ on_date: row.on_date, row })}
                        className="rounded p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                        title="Something wrong with this day?"
                        aria-label={`Request a correction for ${row.on_date}`}
                      >
                        <PenLine className="size-3.5" />
                      </button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {requesting && (
        <CorrectionModal
          initial={requesting}
          onClose={() => setRequesting(null)}
          onDone={async () => { setRequesting(null); await load(); }}
        />
      )}
    </div>
  );
}

const DECISION = {
  pending: { tone: 'caution', icon: Clock3, label: 'Waiting for approval' },
  approved: { tone: 'positive', icon: CheckCircle2, label: 'Approved' },
  rejected: { tone: 'critical', icon: XCircle, label: 'Rejected' },
  withdrawn: { tone: 'neutral', icon: XCircle, label: 'Withdrawn' },
};

function RequestList({ requests, onWithdrawn }) {
  const toast = useToast();
  // Show what is open, plus anything decided in the last fortnight — old
  // history belongs in the log, not on the page.
  const recent = requests.filter((r) =>
    r.decision === 'pending' || (Date.now() - new Date(r.decided_at ?? r.created_at)) < 14 * 86_400_000);
  if (!recent.length) return null;

  async function withdraw(row) {
    try {
      await api.del(`/hr/me/attendance/requests/${row.id}`);
      toast.success('Request withdrawn');
      await onWithdrawn();
    } catch (err) {
      toast.error('Could not withdraw it', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <Card>
      <div className="border-b border-[var(--border-subtle)] px-5 py-3">
        <h2 className="text-md font-semibold">Your correction requests</h2>
      </div>
      <div className="divide-y divide-[var(--border-subtle)]">
        {recent.map((row) => {
          const meta = DECISION[row.decision] ?? DECISION.pending;
          return (
            <div key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="w-28 shrink-0 font-medium">{fmtDate(row.on_date)}</span>
              <span className="tabular text-[var(--text-secondary)]">
                {row.check_in_at ? fmtDate(row.check_in_at, 'time') : '—'} – {row.check_out_at ? fmtDate(row.check_out_at, 'time') : '—'}
              </span>
              <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{row.reason}</span>
              <Badge tone={meta.tone} size="sm"><meta.icon className="size-3" />{meta.label}</Badge>
              {row.decision_note && (
                <span className="w-full text-xs text-[var(--text-tertiary)]">“{row.decision_note}”</span>
              )}
              {row.decision === 'pending' && (
                <Button variant="ghost" size="sm" onClick={() => withdraw(row)}>Withdraw</Button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** "HH:MM" on a date, as the ISO instant the API expects. */
const instant = (day, hhmm) => {
  if (!day || !hhmm) return undefined;
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${day}T00:00:00`);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const hhmm = (value) => {
  if (!value) return '';
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function CorrectionModal({ initial, onClose, onDone }) {
  const toast = useToast();
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const [form, setForm] = useState({
    on_date: initial.on_date ?? yesterday,
    status: 'present',
    check_in: hhmm(initial.row?.check_in_at),
    check_out: hhmm(initial.row?.check_out_at),
    reason: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const outBeforeIn = form.check_in && form.check_out && form.check_out <= form.check_in;

  async function submit() {
    setBusy(true);
    try {
      await api.post('/hr/me/attendance/requests', {
        on_date: form.on_date,
        status: form.status,
        check_in_at: instant(form.on_date, form.check_in),
        check_out_at: instant(form.on_date, form.check_out),
        reason: form.reason.trim(),
      });
      toast.success('Correction requested', {
        description: 'HR will review it. It counts once approved.',
      });
      await onDone();
    } catch (err) {
      toast.error('Could not send that request', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Request an attendance correction"
      description="Forgot to punch, or the terminal was down? Tell HR what the day should say. Nothing changes until they approve it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary" onClick={submit} loading={busy}
            disabled={form.reason.trim().length < 3 || outBeforeIn}
          >
            Send for approval
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" required>
          <Input
            type="date" value={form.on_date} max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => set('on_date', e.target.value)}
          />
        </Field>
        <Field label="The day should count as">
          <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
            <option value="present">Present</option>
            <option value="remote">Working remotely</option>
            <option value="half_day">Half day</option>
          </Select>
        </Field>
        <Field label="In at">
          <Input type="time" value={form.check_in} onChange={(e) => set('check_in', e.target.value)} />
        </Field>
        <Field label="Out at" error={outBeforeIn ? 'Out must be after in' : undefined}>
          <Input type="time" value={form.check_out} onChange={(e) => set('check_out', e.target.value)} />
        </Field>
        <Field label="Why" required className="sm:col-span-2">
          <Textarea
            rows={3} value={form.reason}
            onChange={(e) => set('reason', e.target.value)}
            placeholder="The gate terminal was offline from 9 to 11."
          />
        </Field>
      </div>
    </Modal>
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
