'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Check, X, CalendarOff, Clock, CalendarCheck, Ban, Settings2, Pencil, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
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

  const [policyOpen, setPolicyOpen] = useState(false);
  const reloadTypes = useCallback(() => api.get('/hr/leave-types').then((r) => setTypes(r.data)).catch(() => setTypes([])), []);

  useEffect(() => {
    reloadTypes();
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
          <div className="flex gap-2">
            <Can permission="hr.leave.manage">
              <Button variant="secondary" icon={Settings2} onClick={() => setPolicyOpen(true)}>Leave types</Button>
            </Can>
            <Can permission="hr.leave.create">
              <Button variant="primary" icon={Plus} onClick={() => setRequesting(true)}>Request leave</Button>
            </Can>
          </div>
        }
      />
      <LeaveTypesModal open={policyOpen} types={types} onClose={() => setPolicyOpen(false)} onChanged={reloadTypes} />

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

/* ── leave policy: the types and their days ──────────────────────────────── */
const LEAVE_COLOURS = ['slate', 'rose', 'emerald', 'amber', 'blue', 'violet', 'cyan', 'orange', 'pink', 'teal', 'indigo', 'lime'];

function LeaveTypesModal({ open, types, onClose, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  function edit(type) {
    setProblem(null);
    setEditing(type ?? {});
    setForm(type
      ? { name: type.name, code: type.code, days_per_year: String(Number(type.days_per_year)), is_paid: type.is_paid, carry_forward: type.carry_forward, requires_approval: type.requires_approval, colour: type.colour, update_balances: true }
      : { name: '', code: '', days_per_year: '0', is_paid: true, carry_forward: false, requires_approval: true, colour: 'blue' });
  }

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const payload = {
        name: form.name.trim(), days_per_year: Number(form.days_per_year || 0), is_paid: form.is_paid,
        carry_forward: form.carry_forward, requires_approval: form.requires_approval, colour: form.colour,
        ...(form.code?.trim() ? { code: form.code.trim().toUpperCase() } : {}),
      };
      if (editing.id) {
        const row = (await api.patch(`/hr/leave-types/${editing.id}`, { ...payload, update_balances: form.update_balances })).data;
        toast.success(`${row.name} saved`, { description: row.balances_updated ? `${row.balances_updated} employee balance${row.balances_updated === 1 ? '' : 's'} for this year updated.` : undefined });
      } else {
        await api.post('/hr/leave-types', payload);
        toast.success(`${payload.name} added`, { description: 'Every current employee gets it for this year.' });
      }
      setEditing(null);
      onChanged();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not save it.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await api.del(`/hr/leave-types/${removing.id}`);
      toast.success(`${removing.name} removed`);
      onChanged();
    } catch (err) {
      toast.error('Could not remove it', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setRemoving(null);
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const changedDays = editing?.id && Number(form.days_per_year) !== Number(editing.days_per_year);

  return (
    <>
      <Modal
        open={open && !editing}
        onClose={onClose}
        size="lg"
        title="Leave types"
        description="Sick leave, casual leave, earned leave — how many days each gives in a year."
        footer={<><Button variant="ghost" onClick={onClose}>Done</Button><Button variant="primary" icon={Plus} onClick={() => edit(null)}>Add leave type</Button></>}
      >
        <ul className="divide-y divide-[var(--border-subtle)]">
          {types.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {t.name} <Badge size="sm">{t.code}</Badge>
                </p>
                <p className="text-xs text-[var(--text-tertiary)]">
                  {Number(t.days_per_year)} day{Number(t.days_per_year) === 1 ? '' : 's'} a year · {t.is_paid ? 'paid' : 'unpaid'}
                  {t.carry_forward ? ' · carries forward' : ''}{t.requires_approval ? ' · needs approval' : ' · approved automatically'}
                </p>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => edit(t)}><Pencil className="size-3.5" /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${t.name}`} onClick={() => setRemoving(t)}><Trash2 className="size-3.5" /></Button>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${editing.name}` : 'Add a leave type'}
        footer={<><Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Back</Button><Button variant="primary" loading={busy} disabled={!form.name?.trim()} onClick={save}>Save</Button></>}
      >
        <div className="space-y-4">
          {problem && <Alert tone="critical">{problem}</Alert>}
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <Field label="Name" required>{(p) => <Input {...p} value={form.name ?? ''} onChange={set('name')} placeholder="Sick leave" data-autofocus />}</Field>
            <Field label="Short code" hint="Shown on calendars.">{(p) => <Input {...p} value={form.code ?? ''} onChange={set('code')} placeholder="SL" maxLength={8} />}</Field>
          </div>
          <Field label="Days per year" hint="0 for leave with no fixed allowance, like unpaid leave.">
            {(p) => <Input {...p} type="number" min="0" max="365" step="0.5" value={form.days_per_year ?? ''} onChange={set('days_per_year')} className="max-w-[10rem]" />}
          </Field>
          <div className="space-y-2.5">
            <Checkbox checked={Boolean(form.is_paid)} onChange={set('is_paid')} label="Paid leave" description="Unpaid days are deducted in payroll." />
            <Checkbox checked={Boolean(form.carry_forward)} onChange={set('carry_forward')} label="Unused days carry forward to next year" />
            <Checkbox checked={Boolean(form.requires_approval)} onChange={set('requires_approval')} label="Needs a manager’s approval" />
            {changedDays && (
              <Checkbox checked={Boolean(form.update_balances)} onChange={set('update_balances')} label="Also update this year’s balance for everyone"
                description={`Everyone currently on ${Number(editing.days_per_year)} days moves to ${Number(form.days_per_year || 0)}. Balances you changed for one person by hand are left alone.`} />
            )}
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Colour</p>
            <Select value={form.colour ?? 'slate'} onChange={set('colour')} className="max-w-[10rem]" aria-label="Colour">
              {LEAVE_COLOURS.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        danger
        confirmLabel="Remove"
        title={`Remove ${removing?.name}?`}
        description="People can no longer request it. Leave already taken or requested stays on record."
      />
    </>
  );
}
