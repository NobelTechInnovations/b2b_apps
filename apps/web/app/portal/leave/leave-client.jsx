'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, CalendarOff, X, CheckCircle2, Clock3, XCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, Alert } from '@/components/ui/primitives';
import { date as fmtDate } from '@/lib/format';

const TONE = { pending: 'caution', approved: 'positive', rejected: 'critical', cancelled: 'neutral' };
const ICON = { pending: Clock3, approved: CheckCircle2, rejected: XCircle, cancelled: X };

const today = () => new Date().toISOString().slice(0, 10);

export default function PortalLeave() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [withdrawing, setWithdrawing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/hr/me/leave');
      setData(response.data);
      setMeta(response.meta ?? {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your leave.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function withdraw() {
    setBusy(true);
    try {
      await api.del(`/hr/me/leave/${withdrawing.id}`);
      toast.success('Request withdrawn');
      setWithdrawing(null);
      await load();
    } catch (err) {
      toast.error('Could not withdraw that request', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Leave</h1>
          <p className="mt-1 text-base text-[var(--text-secondary)]">
            What you have left, and what you have asked for.
          </p>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setApplying(true)}>Apply for leave</Button>
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-28 w-full" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.balances.map((balance) => {
              const total = Number(balance.entitled) + Number(balance.carried ?? 0);
              const available = Number(balance.available);
              return (
                <Card key={balance.leave_type_id} className="panel-hover p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-medium">{balance.name}</p>
                    <Badge tone={balance.is_paid ? 'neutral' : 'caution'} size="sm">
                      {balance.is_paid ? balance.code : 'unpaid'}
                    </Badge>
                  </div>
                  <p className="metric mt-2 text-2xl font-semibold tabular tracking-[-0.025em]">
                    {available}
                    <span className="ml-1 text-sm font-normal text-[var(--text-tertiary)]">
                      of {total}
                    </span>
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-brand-500)] transition-[width] duration-500"
                      style={{ width: `${Math.min(100, Math.max(0, (available / Math.max(1, total)) * 100))}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">
                    {Number(balance.used)} taken
                  </p>
                </Card>
              );
            })}
          </div>

          {meta.pending_days > 0 && (
            <Alert tone="info" icon={Clock3}>
              {meta.pending_days} {meta.pending_days === 1 ? 'day is' : 'days are'} awaiting approval.
              They come off your balance only once approved.
            </Alert>
          )}

          <Card>
            <div className="border-b border-[var(--border-subtle)] px-5 py-3">
              <h2 className="text-md font-semibold">Your requests</h2>
            </div>

            {data.requests.length === 0 ? (
              <EmptyState
                icon={CalendarOff}
                title="No leave requested yet"
                description="When you apply, it appears here with its status."
                action={<Button variant="primary" icon={Plus} onClick={() => setApplying(true)}>Apply for leave</Button>}
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Type</TH>
                    <TH>Dates</TH>
                    <TH align="right">Days</TH>
                    <TH>Reason</TH>
                    <TH>Status</TH>
                    <TH align="right">{''}</TH>
                  </tr>
                </THead>
                <TBody>
                  {data.requests.map((row) => {
                    const Icon = ICON[row.status] ?? Clock3;
                    return (
                      <TR key={row.id}>
                        <TD className="font-medium">{row.leave_type_name}</TD>
                        <TD className="whitespace-nowrap">
                          {fmtDate(row.start_date)}
                          {row.end_date !== row.start_date && ` – ${fmtDate(row.end_date)}`}
                        </TD>
                        <TD align="right" numeric>{Number(row.days)}</TD>
                        <TD className="max-w-[16rem] truncate text-[var(--text-secondary)]">
                          {row.reason ?? '—'}
                        </TD>
                        <TD>
                          <Badge tone={TONE[row.status]} size="sm">
                            <Icon className="size-3" />{row.status}
                          </Badge>
                          {row.decision_note && (
                            <p className="mt-0.5 max-w-[14rem] truncate text-xs text-[var(--text-tertiary)]">
                              {row.decision_note}
                            </p>
                          )}
                        </TD>
                        <TD align="right">
                          {row.status === 'pending' && (
                            <Button variant="ghost" size="sm" onClick={() => setWithdrawing(row)}>
                              Withdraw
                            </Button>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </Card>
        </>
      )}

      {applying && data && (
        <ApplyModal
          balances={data.balances}
          onClose={() => setApplying(false)}
          onDone={async () => { setApplying(false); await load(); }}
        />
      )}

      <ConfirmModal
        open={Boolean(withdrawing)}
        onClose={() => setWithdrawing(null)}
        onConfirm={withdraw}
        title="Withdraw this request?"
        description="It will be cancelled. You can apply again for the same dates afterwards."
        confirmLabel="Withdraw"
        loading={busy}
      />
    </div>
  );
}

function ApplyModal({ balances, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    leave_type_id: balances[0]?.leave_type_id ?? '',
    start_date: today(),
    end_date: today(),
    half_day: false,
    reason: '',
  });
  const [busy, setBusy] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const chosen = useMemo(
    () => balances.find((b) => b.leave_type_id === form.leave_type_id),
    [balances, form.leave_type_id],
  );

  // Working days between the two dates, so the modal says what it will cost
  // before the server does.
  const days = useMemo(() => {
    if (!form.start_date || !form.end_date || form.end_date < form.start_date) return 0;
    let count = 0;
    const cursor = new Date(`${form.start_date}T00:00:00Z`);
    const end = new Date(`${form.end_date}T00:00:00Z`);
    while (cursor <= end) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) count += 1;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return form.half_day && count === 1 ? 0.5 : count;
  }, [form.start_date, form.end_date, form.half_day]);

  const over = chosen?.is_paid && days > Number(chosen.available);

  async function submit() {
    setBusy(true);
    try {
      await api.post('/hr/me/leave', {
        leave_type_id: form.leave_type_id,
        start_date: form.start_date,
        end_date: form.end_date,
        half_day: form.half_day,
        reason: form.reason?.trim() || undefined,
      });
      toast.success('Leave requested', { description: 'Your manager will see it straight away.' });
      await onDone();
    } catch (err) {
      toast.error('Could not apply for leave', {
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
      title="Apply for leave"
      description="Weekends are not counted. Your balance is only deducted once it is approved."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={days <= 0 || over} loading={busy}>
            Request {days > 0 ? `${days} day${days === 1 ? '' : 's'}` : 'leave'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" required className="sm:col-span-2">
          <Select value={form.leave_type_id} onChange={(e) => set('leave_type_id', e.target.value)}>
            {balances.map((b) => (
              <option key={b.leave_type_id} value={b.leave_type_id}>
                {b.name} — {Number(b.available)} available
              </option>
            ))}
          </Select>
        </Field>

        <Field label="From" required>
          <Input
            type="date" value={form.start_date}
            onChange={(e) => {
              const value = e.target.value;
              setForm((f) => ({ ...f, start_date: value, end_date: f.end_date < value ? value : f.end_date }));
            }}
          />
        </Field>
        <Field label="To" required>
          <Input
            type="date" value={form.end_date} min={form.start_date}
            onChange={(e) => set('end_date', e.target.value)}
          />
        </Field>

        {form.start_date === form.end_date && (
          <div className="sm:col-span-2">
            <Checkbox
              label="Half day"
              checked={form.half_day}
              onChange={(e) => set('half_day', e.target.checked)}
            />
          </div>
        )}

        <Field label="Reason" className="sm:col-span-2">
          <Textarea
            rows={3} value={form.reason}
            onChange={(e) => set('reason', e.target.value)}
            placeholder="Optional, but it helps your manager decide."
          />
        </Field>
      </div>

      {over && (
        <Alert tone="critical" className="mt-4">
          That is {days} days, but you have only {Number(chosen.available)} of {chosen.name} left.
        </Alert>
      )}
    </Modal>
  );
}
