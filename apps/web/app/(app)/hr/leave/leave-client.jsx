'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Check, X, CalendarOff, Clock, CalendarCheck, Ban } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { StatTile } from '@/components/data/stat-tile';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';

const STATUS_TONE = {
  pending: 'caution', approved: 'positive', rejected: 'critical', cancelled: 'neutral',
};

export default function LeaveClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [requests, setRequests] = useState([]);
  const [meta, setMeta] = useState(null);
  const [types, setTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scope, setScope] = useState('pending');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [requesting, setRequesting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/hr/leave', {
        query: {
          status: scope === 'all' ? undefined : scope,
          q: search || undefined,
          page,
          limit: 25,
          sort: 'start_date',
          order: scope === 'pending' ? 'asc' : 'desc',
        },
      });
      setRequests(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load leave requests.');
    } finally {
      setLoading(false);
    }
  }, [scope, search, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  useEffect(() => {
    api.get('/hr/leave-types').then((r) => setTypes(r.data)).catch(() => setTypes([]));
    api.get('/hr/employees', { query: { status: 'active', limit: 100 } })
      .then((r) => setEmployees(r.data)).catch(() => setEmployees([]));
  }, []);

  async function decide(request, decision) {
    setBusyId(request.id);
    try {
      await api.post(`/hr/leave/${request.id}/decide`, { decision });
      toast.success(decision === 'approved' ? 'Leave approved' : 'Leave rejected', {
        description: decision === 'approved'
          ? `${request.days} day(s) deducted and the calendar blocked out.`
          : undefined,
      });
      await load();
    } catch (err) {
      toast.error('Could not record that decision', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(request) {
    setBusyId(request.id);
    try {
      await api.post(`/hr/leave/${request.id}/cancel`, {});
      toast.success('Leave cancelled', { description: 'Any deducted days have been returned.' });
      await load();
    } catch (err) {
      toast.error('Could not cancel', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusyId(null);
    }
  }

  const counts = meta?.counts;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Leave"
        description="Requests, approvals and who is away."
        actions={
          <Can permission="hr.leave.create">
            <Button variant="primary" icon={Plus} onClick={() => setRequesting(true)}>Request leave</Button>
          </Can>
        }
      />

      {counts && (
        <div className="grid grid-cols-3 gap-4">
          <StatTile label="Awaiting approval" value={counts.pending} icon={Clock}
            tone={counts.pending > 0 ? 'caution' : 'neutral'} />
          <StatTile label="Away today" value={counts.on_leave_today} icon={CalendarOff} />
          <StatTile label="Upcoming" value={counts.upcoming} icon={CalendarCheck} tone="brand" />
        </div>
      )}

      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search by name or reason…"
      >
        <div className="inline-flex rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-0.5">
          {[
            { value: 'pending', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
            { value: 'all', label: 'All' },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => { setScope(option.value); setPage(1); }}
              className={cn(
                'rounded-[var(--radius-sm)] px-2.5 py-1 text-sm font-medium transition-colors',
                scope === option.value
                  ? 'bg-[var(--surface-raised)] text-[var(--text-primary)] shadow-xs'
                  : 'text-[var(--text-secondary)]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </ListToolbar>

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : requests.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarOff}
            title={scope === 'pending' ? 'Nothing awaiting approval' : 'No leave requests'}
            description={
              scope === 'pending'
                ? 'Every request has been dealt with.'
                : 'Leave requests will appear here once someone books time off.'
            }
            action={
              can('hr.leave.create') && (
                <Button variant="primary" icon={Plus} onClick={() => setRequesting(true)}>Request leave</Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            {requests.map((request) => {
              const busy = busyId === request.id;
              const upcoming = new Date(request.end_date) >= new Date();

              return (
                <div key={request.id} className="panel flex flex-wrap items-center gap-3 p-3.5">
                  <Avatar name={request.employee_name} size="md" />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-medium">{request.employee_name}</p>
                    <p className="truncate text-xs text-[var(--text-tertiary)]">
                      {request.leave_type_name}
                      {!request.is_paid && ' (unpaid)'}
                      {' · '}
                      {date(request.start_date, 'short')} – {date(request.end_date, 'short')}
                      {' · '}
                      {request.days} {Number(request.days) === 1 ? 'day' : 'days'}
                    </p>
                    {request.reason && (
                      <p className="mt-1 line-clamp-1 text-sm text-[var(--text-secondary)]">{request.reason}</p>
                    )}
                  </div>

                  <span className="hidden text-xs text-[var(--text-tertiary)] sm:block">
                    {relativeTime(request.created_at)}
                  </span>

                  <Badge size="sm" tone={STATUS_TONE[request.status]}>{request.status}</Badge>

                  {request.status === 'pending' && (
                    <Can permission="hr.leave.approve">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" icon={X} loading={busy}
                          onClick={() => decide(request, 'rejected')}>
                          Reject
                        </Button>
                        <Button variant="primary" size="sm" icon={Check} loading={busy}
                          onClick={() => decide(request, 'approved')}>
                          Approve
                        </Button>
                      </div>
                    </Can>
                  )}

                  {request.status === 'approved' && upcoming && (
                    <Can permission="hr.leave.create">
                      <Button variant="ghost" size="sm" icon={Ban} loading={busy}
                        onClick={() => cancel(request)}>
                        Cancel
                      </Button>
                    </Can>
                  )}
                </div>
              );
            })}
          </div>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <RequestLeaveModal
        open={requesting}
        types={types}
        employees={employees}
        onClose={() => setRequesting(false)}
        onCreated={load}
      />
    </div>
  );
}

function RequestLeaveModal({ open, types, employees, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [balances, setBalances] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  // Show what they actually have left, the moment a person is chosen.
  useEffect(() => {
    if (!form.employee_id) { setBalances([]); return; }
    api.get(`/hr/leave-balances/${form.employee_id}`)
      .then((r) => setBalances(r.data))
      .catch(() => setBalances([]));
  }, [form.employee_id]);

  const selected = balances.find((b) => b.leave_type_id === form.leave_type_id);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form };
      for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];

      const response = await api.post('/hr/leave', payload);
      toast.success(
        response.data.status === 'approved' ? 'Leave booked' : 'Leave requested',
        { description: `${response.data.days} day(s) · ${response.data.available_after} remaining` },
      );
      setForm({});
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit that request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request leave"
      description="Weekends are excluded automatically."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={Plus}>Submit</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        <Field label="Employee" required>
          {(p) => (
            <Select {...p} value={form.employee_id ?? ''} onChange={set('employee_id')} required data-autofocus>
              <option value="">Choose someone…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          )}
        </Field>

        <Field
          label="Leave type"
          required
          hint={
            selected
              ? `${selected.available} day${Number(selected.available) === 1 ? '' : 's'} available${selected.is_paid ? '' : ' (unpaid — no limit)'}`
              : undefined
          }
        >
          {(p) => (
            <Select {...p} value={form.leave_type_id ?? ''} onChange={set('leave_type_id')} required>
              <option value="">Choose a type…</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From" required>
            {(p) => <Input {...p} type="date" value={form.start_date ?? ''} onChange={set('start_date')} required />}
          </Field>
          <Field label="To" required>
            {(p) => (
              <Input {...p} type="date" value={form.end_date ?? ''} onChange={set('end_date')}
                min={form.start_date || undefined} required />
            )}
          </Field>
        </div>

        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={form.half_day ?? false}
            onChange={set('half_day')}
            className="size-4 rounded-[var(--radius-xs)] border-[var(--border-strong)] text-[var(--color-brand-600)]"
          />
          <span className="text-base">Half day</span>
          <span className="text-xs text-[var(--text-tertiary)]">Single-day requests only</span>
        </label>

        <Field label="Reason">
          {(p) => <Textarea {...p} rows={2} value={form.reason ?? ''} onChange={set('reason')} />}
        </Field>
      </form>
    </Modal>
  );
}
