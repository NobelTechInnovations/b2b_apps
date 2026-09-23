'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, CalendarClock, Clock, Moon, Sun, Users, Trash2, Pencil, Check,
  TrendingUp, TrendingDown, CalendarRange, Coffee,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Table, THead, TBody, TH, TR, TD } from '@/components/ui/table';
import { StatTile } from '@/components/data/stat-tile';
import {
  Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton, Divider,
} from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

const DAYS = [
  { n: 1, short: 'M', label: 'Monday' },
  { n: 2, short: 'T', label: 'Tuesday' },
  { n: 3, short: 'W', label: 'Wednesday' },
  { n: 4, short: 'T', label: 'Thursday' },
  { n: 5, short: 'F', label: 'Friday' },
  { n: 6, short: 'S', label: 'Saturday' },
  { n: 7, short: 'S', label: 'Sunday' },
];

const BLANK = {
  name: '', code: '', starts_at: '09:00', ends_at: '18:00',
  break_minutes: 60, grace_minutes: 10, half_day_minutes: 240,
  overtime_after_minutes: 0, working_days: [1, 2, 3, 4, 5], is_default: false,
};

const hours = (minutes) => {
  if (minutes == null) return '—';
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : ''}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m`;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function ShiftsClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [shifts, setShifts] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [roster, setRoster] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('shifts');

  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, a] = await Promise.all([
        api.get('/hr/shifts'),
        api.get('/hr/shifts/assignments'),
      ]);
      setShifts(s.data);
      setAssignments(a.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load shifts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The roster is the expensive read, so it waits until somebody asks for it.
  useEffect(() => {
    if (tab !== 'roster' || roster) return;
    api.get('/hr/shifts/roster', { query: { from: todayISO(), days: 7 } })
      .then((r) => setRoster(r))
      .catch(() => setRoster({ data: [], meta: { dates: [] } }));
  }, [tab, roster]);

  async function save(form) {
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        code: form.code?.trim() || undefined,
        starts_at: form.starts_at,
        ends_at: form.ends_at,
        break_minutes: Number(form.break_minutes),
        grace_minutes: Number(form.grace_minutes),
        half_day_minutes: Number(form.half_day_minutes),
        overtime_after_minutes: Number(form.overtime_after_minutes),
        working_days: form.working_days,
        is_default: form.is_default,
      };

      if (form.id) {
        const response = await api.patch(`/hr/shifts/${form.id}`, payload);
        const touched = response.meta?.attendance_recomputed ?? 0;
        toast.success(`${payload.name} updated`, {
          description: touched
            ? `${touched} attendance ${touched === 1 ? 'record was' : 'records were'} recalculated.`
            : undefined,
        });
      } else {
        await api.post('/hr/shifts', payload);
        toast.success(`${payload.name} created`);
      }

      setEditing(null);
      setRoster(null);
      await load();
    } catch (err) {
      toast.error('Could not save that shift', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.del(`/hr/shifts/${deleting.id}`);
      toast.success(`${deleting.name} removed`);
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error('Could not remove that shift', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  const totalAssigned = shifts.reduce((sum, s) => sum + (s.assigned_count ?? 0), 0);
  const nightShifts = shifts.filter((s) => s.is_night_shift).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Shifts & working hours"
        description="Define when people are expected in. Overtime and short time are worked out from these."
        actions={
          <Can permission="hr.shifts.manage">
            <Button variant="primary" icon={Plus} onClick={() => setEditing({ ...BLANK })}>
              New shift
            </Button>
          </Can>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Shifts defined" value={shifts.length} icon={CalendarClock} loading={loading} />
        <StatTile label="People scheduled" value={totalAssigned} icon={Users} loading={loading} />
        <StatTile label="Night shifts" value={nightShifts} icon={Moon} loading={loading} tone={nightShifts ? 'brand' : 'neutral'} />
        <StatTile
          label="Standard day"
          value={hours(shifts.find((s) => s.is_default)?.paid_minutes)}
          format="raw"
          icon={Clock}
          loading={loading}
          hint="paid hours, breaks excluded"
        />
      </div>

      <div className="flex gap-1 border-b border-[var(--border-subtle)]" data-tour="shift-tabs">
        {[
          { key: 'shifts', label: 'Shifts', icon: CalendarClock },
          { key: 'people', label: 'Who works when', icon: Users },
          { key: 'roster', label: 'Week ahead', icon: CalendarRange },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors',
              tab === item.key
                ? 'border-b-2 border-[var(--color-brand-500)] text-[var(--text-primary)]'
                : 'border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-48 w-full" />)}
        </div>
      ) : tab === 'shifts' ? (
        <ShiftGrid
          shifts={shifts}
          can={can}
          onEdit={(shift) => setEditing(toForm(shift))}
          onDelete={setDeleting}
          onAssign={setAssigning}
          onCreate={() => setEditing({ ...BLANK })}
        />
      ) : tab === 'people' ? (
        <AssignmentTable assignments={assignments} shifts={shifts} can={can} onAssign={setAssigning} />
      ) : (
        <RosterGrid roster={roster} />
      )}

      {editing && (
        <ShiftEditor
          initial={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}

      {assigning && (
        <AssignModal
          shift={assigning}
          shifts={shifts}
          assignments={assignments}
          onClose={() => setAssigning(null)}
          onDone={async () => { setAssigning(null); setRoster(null); await load(); }}
        />
      )}

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title={`Remove ${deleting?.name}?`}
        description="Attendance already recorded against this shift keeps its hours. Nobody can be scheduled on it again."
        confirmLabel="Remove shift"
        danger
        loading={busy}
      />
    </div>
  );
}

const toForm = (shift) => ({
  id: shift.id,
  name: shift.name,
  code: shift.code ?? '',
  starts_at: shift.starts_at,
  ends_at: shift.ends_at,
  break_minutes: shift.break_minutes,
  grace_minutes: shift.grace_minutes,
  half_day_minutes: shift.half_day_minutes,
  overtime_after_minutes: shift.overtime_after_minutes,
  working_days: shift.working_days ?? [1, 2, 3, 4, 5],
  is_default: shift.is_default,
});

/* ── the shift cards ────────────────────────────────────────────────────── */
function ShiftGrid({ shifts, can, onEdit, onDelete, onAssign, onCreate }) {
  if (!shifts.length) {
    return (
      <Card>
        <EmptyState
          icon={CalendarClock}
          title="No shifts yet"
          description="A shift says when the working day starts and ends. Everything about overtime follows from it."
          action={can('hr.shifts.manage') && (
            <Button variant="primary" icon={Plus} onClick={onCreate}>Create a shift</Button>
          )}
        />
      </Card>
    );
  }

  return (
    <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {shifts.map((shift) => (
        <Card key={shift.id} className="panel-hover flex flex-col p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-md font-semibold">{shift.name}</h3>
                {shift.is_default && <Badge tone="brand" size="sm">Default</Badge>}
              </div>
              {shift.code && (
                <p className="mt-0.5 text-xs tabular text-[var(--text-tertiary)]">{shift.code}</p>
              )}
            </div>
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)]',
                shift.is_night_shift
                  ? 'bg-[rgb(99_102_241/0.1)] text-[var(--color-brand-600)] dark:text-[var(--color-brand-400)]'
                  : 'bg-[var(--color-caution-50)] text-[var(--color-caution-600)] dark:bg-[rgb(245_158_11/0.12)]',
              )}
            >
              {shift.is_night_shift ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </span>
          </div>

          <div className="mt-4 flex items-baseline gap-2">
            <span className="metric text-xl font-semibold tabular tracking-[-0.02em]">
              {shift.starts_at}
            </span>
            <span className="text-[var(--text-tertiary)]">→</span>
            <span className="metric text-xl font-semibold tabular tracking-[-0.02em]">
              {shift.ends_at}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />{hours(shift.paid_minutes)} paid
            </span>
            <span className="inline-flex items-center gap-1">
              <Coffee className="size-3" />{shift.break_minutes}m break
            </span>
            {shift.grace_minutes > 0 && <span>{shift.grace_minutes}m grace</span>}
          </div>

          <div className="mt-4 flex gap-1" title={shift.working_day_labels?.join(', ')}>
            {DAYS.map((day) => {
              const on = shift.working_days?.includes(day.n);
              return (
                <span
                  key={day.n}
                  className={cn(
                    'flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-2xs font-semibold',
                    on
                      ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)] dark:bg-[rgb(99_102_241/0.14)] dark:text-[var(--color-brand-300)]'
                      : 'bg-[var(--surface-sunken)] text-[var(--text-disabled)]',
                  )}
                >
                  {day.short}
                </span>
              );
            })}
          </div>

          <div className="mt-auto pt-4">
            <button
              onClick={() => onAssign(shift)}
              className="flex w-full items-center gap-2 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
            >
              <Users className="size-4 text-[var(--text-tertiary)]" />
              <span className="text-sm">
                <span className="font-semibold tabular">{shift.assigned_count}</span>{' '}
                <span className="text-[var(--text-secondary)]">
                  {shift.assigned_count === 1 ? 'person' : 'people'}
                </span>
              </span>
              {shift.inherited_count > 0 && (
                <Badge tone="neutral" size="sm" className="ml-auto">
                  {shift.inherited_count} inherited
                </Badge>
              )}
            </button>
          </div>

          <Can permission="hr.shifts.manage">
            <div className="mt-3 flex gap-1 border-t border-[var(--border-subtle)] pt-3">
              <Button variant="ghost" size="sm" icon={Pencil} onClick={() => onEdit(shift)}>Edit</Button>
              <Button
                variant="danger-ghost"
                size="sm"
                icon={Trash2}
                onClick={() => onDelete(shift)}
                disabled={shift.is_default || shift.assigned_count > shift.inherited_count}
                title={shift.is_default ? 'The default shift cannot be removed' : undefined}
              >
                Remove
              </Button>
            </div>
          </Can>
        </Card>
      ))}
    </div>
  );
}

/* ── who works when ─────────────────────────────────────────────────────── */
function AssignmentTable({ assignments, shifts, can, onAssign }) {
  const [filter, setFilter] = useState('');

  const rows = useMemo(
    () => (filter ? assignments.filter((a) => a.shift_id === filter) : assignments),
    [assignments, filter],
  );

  if (!assignments.length) {
    return (
      <Card>
        <EmptyState icon={Users} title="Nobody on the payroll yet" description="Add people in Employees first." />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-5 py-3">
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-auto min-w-[11rem]">
          <option value="">All shifts</option>
          {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <p className="text-sm text-[var(--text-secondary)]">
          {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </p>
        <div className="flex-1" />
        {can('hr.shifts.manage') && shifts.length > 0 && (
          <Button variant="secondary" size="sm" icon={Users} onClick={() => onAssign(shifts[0])}>
            Move people to a shift
          </Button>
        )}
      </div>

      <Table>
        <THead>
          <tr>
            <TH>Person</TH>
            <TH>Department</TH>
            <TH>Shift</TH>
            <TH>Hours</TH>
            <TH>Since</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.employee_id}>
              <TD>
                <div className="flex items-center gap-2.5">
                  <Avatar name={row.name} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{row.name}</p>
                    <p className="truncate text-xs text-[var(--text-tertiary)]">
                      {row.designation ?? row.employee_code}
                    </p>
                  </div>
                </div>
              </TD>
              <TD>{row.department_name ?? '—'}</TD>
              <TD>
                <div className="flex items-center gap-1.5">
                  <span>{row.shift_name ?? '—'}</span>
                  {row.inherited && (
                    <Badge tone="neutral" size="sm" title="Follows the workspace default">
                      default
                    </Badge>
                  )}
                </div>
              </TD>
              <TD className="tabular">{row.window ?? '—'}</TD>
              <TD className="text-[var(--text-tertiary)]">{row.effective_from ?? '—'}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

/* ── the week ahead ─────────────────────────────────────────────────────── */
function RosterGrid({ roster }) {
  if (!roster) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!roster.data?.length) {
    return (
      <Card>
        <EmptyState icon={CalendarRange} title="Nothing to roster" description="Add people to see the week ahead." />
      </Card>
    );
  }

  const dates = roster.meta?.dates ?? [];
  const perDate = roster.meta?.per_date ?? {};
  const label = (iso) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' });

  const STATE = {
    working: 'bg-[var(--color-positive-50)] text-[var(--color-positive-700)] dark:bg-[rgb(16_185_129/0.12)] dark:text-[var(--color-positive-500)]',
    leave: 'bg-[var(--color-caution-50)] text-[var(--color-caution-700)] dark:bg-[rgb(245_158_11/0.12)] dark:text-[var(--color-caution-500)]',
    off: 'bg-[var(--surface-sunken)] text-[var(--text-disabled)]',
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
        <p className="text-sm text-[var(--text-secondary)]">
          {roster.meta?.headcount} people · {hours(roster.meta?.expected_minutes)} of scheduled time
        </p>
        <div className="flex items-center gap-3 text-xs">
          {[['working', 'Working'], ['leave', 'On leave'], ['off', 'Off']].map(([key, text]) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span className={cn('size-2.5 rounded-full', STATE[key])} />
              <span className="text-[var(--text-secondary)]">{text}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--border-subtle)]">
              <th className="sticky left-0 z-10 bg-[var(--surface-raised)] px-5 py-2.5 text-left text-xs font-semibold text-[var(--text-secondary)]">
                Person
              </th>
              {dates.map((iso) => (
                <th key={iso} className="px-2 py-2.5 text-center text-xs font-semibold">
                  <div>{label(iso)}</div>
                  <div className="mt-0.5 font-normal tabular text-[var(--text-tertiary)]">
                    {perDate[iso]?.working ?? 0} in
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roster.data.map((row) => (
              <tr key={row.employee_id} className="border-b border-[var(--border-subtle)] last:border-0">
                <td className="sticky left-0 z-10 bg-[var(--surface-raised)] px-5 py-2">
                  <div className="flex items-center gap-2">
                    <Avatar name={row.name} size="xs" />
                    <span className="truncate font-medium">{row.name}</span>
                  </div>
                </td>
                {row.cells.map((cell) => (
                  <td key={cell.date} className="px-1.5 py-2">
                    <div
                      className={cn(
                        'rounded-[var(--radius-sm)] px-1.5 py-1 text-center text-2xs font-medium tabular',
                        STATE[cell.state],
                      )}
                      title={cell.shift_name ?? undefined}
                    >
                      {cell.window ?? (cell.state === 'leave' ? 'Leave' : '—')}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ── the editor, with a live preview ────────────────────────────────────── */
function ShiftEditor({ initial, busy, onClose, onSave }) {
  const [form, setForm] = useState(initial);
  const [preview, setPreview] = useState(null);
  const [sample, setSample] = useState({ in: '09:25', out: '19:30' });

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const toggleDay = (n) =>
    setForm((f) => ({
      ...f,
      working_days: f.working_days.includes(n)
        ? f.working_days.filter((d) => d !== n)
        : [...f.working_days, n].sort(),
    }));

  // Ask the server what these settings would actually pay. Doing the sum on
  // the client would be a second implementation that could disagree with the
  // one that runs payroll.
  useEffect(() => {
    const timer = setTimeout(() => {
      const date = todayISO();
      api.post('/hr/shifts/preview', {
        starts_at: form.starts_at,
        ends_at: form.ends_at,
        break_minutes: Number(form.break_minutes) || 0,
        grace_minutes: Number(form.grace_minutes) || 0,
        half_day_minutes: Number(form.half_day_minutes) || 0,
        overtime_after_minutes: Number(form.overtime_after_minutes) || 0,
        working_days: form.working_days.length ? form.working_days : [1, 2, 3, 4, 5],
        on_date: date,
        check_in_at: new Date(`${date}T${sample.in}:00`).toISOString(),
        check_out_at: new Date(`${date}T${sample.out}:00`).toISOString(),
      })
        .then((r) => setPreview(r.data))
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [form.starts_at, form.ends_at, form.break_minutes, form.grace_minutes,
      form.half_day_minutes, form.overtime_after_minutes, form.working_days, sample]);

  const valid = form.name.trim().length > 0 && form.working_days.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={form.id ? `Edit ${initial.name}` : 'New shift'}
      description="Everything about overtime and short time is worked out from these numbers."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(form)} disabled={!valid} loading={busy}>
            {form.id ? 'Save changes' : 'Create shift'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="General shift"
            autoFocus
          />
        </Field>

        <Field label="Starts at" required>
          <Input type="time" value={form.starts_at} onChange={(e) => set('starts_at', e.target.value)} />
        </Field>
        <Field label="Ends at" required hint={preview?.is_night_shift ? 'Runs past midnight' : undefined}>
          <Input type="time" value={form.ends_at} onChange={(e) => set('ends_at', e.target.value)} />
        </Field>

        <Field label="Unpaid break" hint="Minutes deducted from the day">
          <Input
            type="number" min="0" max="480"
            value={form.break_minutes}
            onChange={(e) => set('break_minutes', e.target.value)}
          />
        </Field>
        <Field label="Late grace" hint="Arriving within this is not late">
          <Input
            type="number" min="0" max="120"
            value={form.grace_minutes}
            onChange={(e) => set('grace_minutes', e.target.value)}
          />
        </Field>

        <Field label="Half day below" hint="Minutes worked, under which the day is a half day">
          <Input
            type="number" min="0" max="720"
            value={form.half_day_minutes}
            onChange={(e) => set('half_day_minutes', e.target.value)}
          />
        </Field>
        <Field label="Overtime after" hint="Extra minutes forgiven before overtime starts">
          <Input
            type="number" min="0" max="480"
            value={form.overtime_after_minutes}
            onChange={(e) => set('overtime_after_minutes', e.target.value)}
          />
        </Field>

        <Field label="Working days" required className="sm:col-span-2">
          <div className="flex gap-1.5">
            {DAYS.map((day) => {
              const on = form.working_days.includes(day.n);
              return (
                <button
                  key={day.n}
                  type="button"
                  onClick={() => toggleDay(day.n)}
                  title={day.label}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-[var(--radius-md)] text-sm font-semibold transition-colors',
                    on
                      ? 'bg-[var(--color-brand-600)] text-white'
                      : 'bg-[var(--surface-sunken)] text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]',
                  )}
                >
                  {day.short}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="sm:col-span-2">
          <Checkbox
            label="Make this the default shift"
            description="Anyone without their own shift follows it."
            checked={form.is_default}
            onChange={(e) => set('is_default', e.target.checked)}
          />
        </div>
      </div>

      <Divider label="What this pays" className="my-5" />

      <div className="rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="If somebody arrives at" className="w-auto">
            <Input
              type="time" size="sm" className="w-28"
              value={sample.in}
              onChange={(e) => setSample((s) => ({ ...s, in: e.target.value }))}
            />
          </Field>
          <Field label="and leaves at" className="w-auto">
            <Input
              type="time" size="sm" className="w-28"
              value={sample.out}
              onChange={(e) => setSample((s) => ({ ...s, out: e.target.value }))}
            />
          </Field>
        </div>

        {preview ? (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Worked" value={hours(preview.work_minutes)} />
            <Metric label="Expected" value={hours(preview.expected_minutes)} />
            <Metric
              label="Overtime"
              value={hours(preview.overtime_minutes)}
              tone={preview.overtime_minutes > 0 ? 'positive' : 'muted'}
              icon={TrendingUp}
            />
            <Metric
              label={preview.shortfall_minutes > 0 ? 'Short by' : 'Late by'}
              value={hours(preview.shortfall_minutes > 0 ? preview.shortfall_minutes : preview.late_minutes)}
              tone={(preview.shortfall_minutes || preview.late_minutes) > 0 ? 'critical' : 'muted'}
              icon={TrendingDown}
            />
            <div className="col-span-2 sm:col-span-4">
              <Badge tone={preview.status === 'present' ? 'positive' : preview.status === 'absent' ? 'critical' : 'caution'}>
                Recorded as {String(preview.status).replace('_', ' ')}
              </Badge>
            </div>
          </div>
        ) : (
          <Skeleton className="mt-4 h-16 w-full" />
        )}
      </div>
    </Modal>
  );
}

function Metric({ label, value, tone = 'muted', icon: Icon }) {
  const tones = {
    muted: 'text-[var(--text-primary)]',
    positive: 'text-[var(--color-positive-600)] dark:text-[var(--color-positive-500)]',
    critical: 'text-[var(--color-critical-600)] dark:text-[var(--color-critical-500)]',
  };
  return (
    <div>
      <p className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
        {Icon && <Icon className="size-3" />}{label}
      </p>
      <p className={cn('metric mt-0.5 text-md font-semibold tabular', tones[tone])}>{value}</p>
    </div>
  );
}

/* ── moving people between shifts ───────────────────────────────────────── */
function AssignModal({ shift, shifts, assignments, onClose, onDone }) {
  const toast = useToast();
  const [target, setTarget] = useState(shift.id);
  const [from, setFrom] = useState(todayISO());
  const [picked, setPicked] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assignments.filter((a) => !q || a.name.toLowerCase().includes(q)
      || (a.employee_code ?? '').toLowerCase().includes(q));
  }, [assignments, search]);

  async function assign() {
    setBusy(true);
    try {
      const response = await api.post(`/hr/shifts/${target}/assign`, {
        employee_ids: [...picked],
        effective_from: from,
      });
      const touched = response.meta?.attendance_recomputed ?? 0;
      toast.success(
        `${response.data.assigned} ${response.data.assigned === 1 ? 'person' : 'people'} moved`,
        { description: touched ? `${touched} attendance records recalculated.` : undefined },
      );
      await onDone();
    } catch (err) {
      toast.error('Could not assign that shift', {
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
      title="Assign a shift"
      description="The previous shift is closed the day before this one starts, so past payslips keep their hours."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={assign} disabled={picked.size === 0} loading={busy}>
            Assign {picked.size > 0 ? `${picked.size} ` : ''}
            {picked.size === 1 ? 'person' : 'people'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shift" required>
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.starts_at}–{s.ends_at})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Effective from" required>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <Input
            size="sm"
            placeholder="Find a person…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setPicked(new Set(visible.map((v) => v.employee_id)))}
            className="text-xs font-medium text-[var(--color-brand-600)] hover:underline"
          >
            Select all {visible.length}
          </button>
          {picked.size > 0 && (
            <button
              type="button"
              onClick={() => setPicked(new Set())}
              className="text-xs font-medium text-[var(--text-secondary)] hover:underline"
            >
              Clear
            </button>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
          {visible.map((person) => {
            const on = picked.has(person.employee_id);
            return (
              <button
                key={person.employee_id}
                type="button"
                onClick={() =>
                  setPicked((set) => {
                    const next = new Set(set);
                    if (next.has(person.employee_id)) next.delete(person.employee_id);
                    else next.add(person.employee_id);
                    return next;
                  })
                }
                className={cn(
                  'flex w-full items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2 text-left last:border-0 transition-colors',
                  on ? 'bg-[var(--color-brand-50)] dark:bg-[rgb(99_102_241/0.1)]' : 'hover:bg-[var(--surface-hover)]',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-xs)] border',
                    on
                      ? 'border-[var(--color-brand-600)] bg-[var(--color-brand-600)] text-white'
                      : 'border-[var(--border-default)]',
                  )}
                >
                  {on && <Check className="size-3" strokeWidth={3} />}
                </span>
                <Avatar name={person.name} size="xs" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{person.name}</span>
                  <span className="block truncate text-xs text-[var(--text-tertiary)]">
                    {person.department_name ?? person.designation ?? '—'}
                  </span>
                </span>
                <Badge tone="neutral" size="sm">{person.shift_name ?? '—'}</Badge>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
