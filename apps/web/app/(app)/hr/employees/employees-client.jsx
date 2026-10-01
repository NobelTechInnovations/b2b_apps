'use client';
import { SourceTaskButton } from '@/components/tasks/source-task-button';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Plus, Users, UserPlus, Clock, Mail, Phone, Network, LogOut, UserRound, Pencil,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { ListToolbar, Pagination } from '@/components/data/list-shell';
import { StatTile } from '@/components/data/stat-tile';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

const STATUS_TONE = {
  active: 'positive', on_probation: 'caution', on_notice: 'critical',
  on_leave: 'info', exited: 'neutral',
};

const label = (value) => value?.replace(/_/g, ' ') ?? '—';

export default function EmployeesClient() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useWorkspace();

  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  // Search params are not available to the useState initialiser under
  // Suspense, so deep links are applied here instead.
  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
    const open = params.get('open');
    if (open) setSelectedId(open);
  }, [params]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/hr/employees', {
        query: { ...filters, q: search || undefined, page, limit: 25 },
      });
      setEmployees(response.data);
      setMeta(response.meta);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load employees.');
    } finally {
      setLoading(false);
    }
  }, [filters, search, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  useEffect(() => {
    api.get('/hr/departments').then((r) => setDepartments(r.data)).catch(() => setDepartments([]));
  }, []);

  const stats = meta?.stats;

  const FILTERS = [
    {
      key: 'status',
      label: 'Status',
      options: ['active', 'on_probation', 'on_notice', 'exited'].map((v) => ({
        value: v, label: label(v).replace(/^\w/, (m) => m.toUpperCase()),
      })),
    },
    {
      key: 'department_id',
      label: 'Department',
      options: departments.map((d) => ({ value: d.id, label: d.name })),
    },
    {
      key: 'employment_type',
      label: 'Type',
      options: ['full_time', 'part_time', 'contract', 'intern', 'consultant'].map((v) => ({
        value: v, label: label(v).replace(/^\w/, (m) => m.toUpperCase()),
      })),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employees"
        description="Everyone on the team, past and present."
        actions={
          <Can permission="hr.employees.create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add employee</Button>
          </Can>
        }
      />

      <Can permission="hr.employees.create">
        <WorkspacePeople onAdded={load} />
      </Can>

      {stats && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Headcount" value={stats.headcount} icon={Users} tone="brand" />
          <StatTile label="On probation" value={stats.on_probation} icon={Clock} />
          <StatTile label="On notice" value={stats.on_notice} icon={LogOut}
            tone={stats.on_notice > 0 ? 'caution' : 'neutral'} />
          <StatTile label="Joined this month" value={stats.joined_this_month} icon={UserPlus} tone="positive" />
        </div>
      )}

      <ListToolbar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Search name, code, email or role…"
        filters={FILTERS}
        values={filters}
        onFilter={(key, value) => {
          setFilters((c) => {
            const next = { ...c };
            if (value === undefined) delete next[key]; else next[key] = value;
            return next;
          });
          setPage(1);
        }}
        onClear={() => { setFilters({}); setPage(1); }}
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <TableSkeleton rows={6} columns={6} />
      ) : employees.length === 0 ? (
        <Card>
          <EmptyState
            icon={UserRound}
            title={search || Object.keys(filters).length ? 'Nobody matches those filters' : 'No employees yet'}
            description={
              search || Object.keys(filters).length
                ? 'Try clearing a filter or searching for something broader.'
                : 'Add your first employee — leave balances open automatically.'
            }
            action={
              can('hr.employees.create') && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add an employee</Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Employee</TH>
                <TH>Code</TH>
                <TH>Department</TH>
                <TH>Manager</TH>
                <TH>Status</TH>
                <TH>Joined</TH>
              </tr>
            </THead>
            <TBody>
              {employees.map((employee) => (
                <TR key={employee.id} onClick={() => setSelectedId(employee.id)}>
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={employee.name} size="md" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{employee.name}</p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">
                          {employee.designation ?? employee.email ?? '—'}
                        </p>
                      </div>
                    </div>
                  </TD>
                  <TD className="tabular text-[var(--text-secondary)]">{employee.employee_code}</TD>
                  <TD className="text-[var(--text-secondary)]">{employee.department_name ?? '—'}</TD>
                  <TD className="text-[var(--text-secondary)]">{employee.manager_name ?? '—'}</TD>
                  <TD>
                    <Badge size="sm" tone={STATUS_TONE[employee.status]}>{label(employee.status)}</Badge>
                  </TD>
                  <TD className="text-[var(--text-secondary)]">{date(employee.joined_on)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={meta} onPage={setPage} />
        </>
      )}

      <EmployeeDrawer
        employeeId={selectedId}
        departments={departments}
        employees={employees}
        onClose={() => { setSelectedId(null); router.replace('/hr/employees'); }}
        onChanged={load}
      />

      <EmployeeFormModal
        open={creating}
        departments={departments}
        employees={employees}
        onClose={() => { setCreating(false); router.replace('/hr/employees'); }}
        onSaved={load}
      />
    </div>
  );
}

function EmployeeDrawer({ employeeId, departments, employees, onClose, onChanged }) {
  const toast = useToast();
  const [employee, setEmployee] = useState(null);
  const [editing, setEditing] = useState(false);
  const [offboarding, setOffboarding] = useState(false);
  const [rehiring, setRehiring] = useState(false);
  const [rejoin, setRejoin] = useState({ joined_on: new Date().toISOString().slice(0, 10), status: 'active' });
  const [busy, setBusy] = useState(false);

  async function rehire() {
    setBusy(true);
    try {
      const response = await api.post(`/hr/employees/${employeeId}/rehire`, {
        joined_on: rejoin.joined_on || undefined, status: rejoin.status, designation: rejoin.designation?.trim() || undefined,
      });
      setEmployee(response.data);
      toast.success(`${response.data.name} is back`, { description: 'Active again for attendance, leave and payroll. Their earlier exit is kept in the notes.' });
      setRehiring(false);
      onChanged?.();
    } catch (error) {
      toast.error('Could not re-hire', { description: error instanceof ApiError ? error.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!employeeId) { setEmployee(null); return; }
    api.get(`/hr/employees/${employeeId}`).then((r) => setEmployee(r.data)).catch(() => setEmployee(null));
  }, [employeeId]);

  async function offboard() {
    setBusy(true);
    try {
      const response = await api.post(`/hr/employees/${employeeId}/offboard`, {});
      toast.success('Offboarded', {
        description: response.data.reports_reassigned > 0
          ? `${response.data.reports_reassigned} direct report(s) reassigned.`
          : undefined,
      });
      setOffboarding(false);
      onChanged?.();
      onClose();
    } catch (error) {
      toast.error('Could not offboard', {
        description: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  if (!employeeId) return null;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        width="lg"
        title={employee?.name ?? 'Employee'}
        subtitle={employee?.designation}
        badge={employee && <Badge size="sm" tone={STATUS_TONE[employee.status]}>{label(employee.status)}</Badge>}
        footer={
          employee && (
            <Can permission="hr.employees.edit">
              {employee.status === 'exited' ? (
                <Button variant="primary" icon={UserPlus} onClick={() => { setRejoin({ joined_on: new Date().toISOString().slice(0, 10), status: 'active', designation: employee.designation ?? '' }); setRehiring(true); }}>
                  Re-hire
                </Button>
              ) : (
                <>
                  <Button variant="danger-ghost" icon={LogOut} onClick={() => setOffboarding(true)}>
                    Offboard
                  </Button>
                  <div className="flex-1" />
                  <Button variant="primary" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>
                </>
              )}
            </Can>
          )
        }
      >
        {!employee ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14 w-full" />)}</div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-4">
              <Avatar name={employee.name} size="xl" />
              <div className="flex gap-2">
<SourceTaskButton app="hr" type="employee" recordId={employee.id} title={`Onboarding: ${employee.name}`} />
                {employee.email && (
                  <a href={`mailto:${employee.email}`}><Button variant="secondary" size="sm" icon={Mail}>Email</Button></a>
                )}
                {employee.phone && (
                  <a href={`tel:${employee.phone}`}><Button variant="secondary" size="sm" icon={Phone}>Call</Button></a>
                )}
              </div>
            </div>

            <DetailGrid
              items={[
                { label: 'Employee code', value: employee.employee_code },
                { label: 'Work email', value: employee.email },
                { label: 'Phone', value: employee.phone },
                { label: 'Department', value: employee.department_name },
                { label: 'Manager', value: employee.manager_name },
                { label: 'Employment type', value: label(employee.employment_type) },
                { label: 'Work location', value: employee.work_location },
                { label: 'Joined', value: date(employee.joined_on) },
                { label: 'Date of birth', value: employee.date_of_birth ? date(employee.date_of_birth) : null },
                { label: 'Exited', value: employee.exited_on ? date(employee.exited_on) : null },
                { label: 'Exit reason', value: employee.exit_reason },
                { label: 'Notes', value: employee.notes, full: true },
              ]}
            />

            {/* ── leave balances ────────────────────────────────────────── */}
            <div>
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
                Leave balance · {new Date().getFullYear()}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {employee.leave_balances.map((balance) => {
                  const total = Number(balance.entitled) + Number(balance.carried);
                  const pct = total > 0 ? (Number(balance.used) / total) * 100 : 0;
                  return (
                    <div key={balance.leave_type_id} className="panel p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm">{balance.name}</span>
                        <span className="shrink-0 text-sm font-semibold tabular">
                          {balance.available}
                          <span className="text-xs font-normal text-[var(--text-tertiary)]">
                            {' '}/ {total || '∞'}
                          </span>
                        </span>
                      </div>
                      {total > 0 && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                          <div
                            className={cn('h-full rounded-full transition-all duration-500',
                              pct > 80 ? 'bg-[var(--color-critical-500)]' : 'bg-[var(--color-brand-500)]')}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── direct reports ────────────────────────────────────────── */}
            {employee.direct_reports.length > 0 && (
              <div>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--text-secondary)]">
                  <Network className="size-3.5" />
                  Direct reports ({employee.direct_reports.length})
                </h3>
                <ul className="space-y-2">
                  {employee.direct_reports.map((report) => (
                    <li key={report.id} className="panel flex items-center gap-3 px-3 py-2.5">
                      <Avatar name={`${report.first_name} ${report.last_name ?? ''}`} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-base font-medium">
                          {[report.first_name, report.last_name].filter(Boolean).join(' ')}
                        </p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">{report.designation ?? '—'}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── recent leave ──────────────────────────────────────────── */}
            <div>
              <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Recent leave</h3>
              {employee.recent_leave.length === 0 ? (
                <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-5 text-center text-sm text-[var(--text-tertiary)]">
                  No leave recorded.
                </p>
              ) : (
                <ul className="space-y-2">
                  {employee.recent_leave.map((leave) => (
                    <li key={leave.id} className="panel flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-base">{leave.leave_type_name}</p>
                        <p className="text-xs text-[var(--text-tertiary)]">
                          {date(leave.start_date, 'short')} – {date(leave.end_date, 'short')} · {leave.days} days
                        </p>
                      </div>
                      <Badge size="sm" tone={leave.status === 'approved' ? 'positive' : leave.status === 'pending' ? 'caution' : 'neutral'}>
                        {leave.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Drawer>

      <EmployeeFormModal
        open={editing}
        employee={employee}
        departments={departments}
        employees={employees}
        onClose={() => setEditing(false)}
        onSaved={() => {
          // Reload: the department and manager names come from the full record.
          api.get(`/hr/employees/${employeeId}`).then((r) => setEmployee(r.data)).catch(() => {});
          onChanged?.();
        }}
      />

      <Modal
        open={rehiring}
        onClose={() => setRehiring(false)}
        title={`Re-hire ${employee?.name ?? ''}`}
        description="They become active again with the same employee code. Their earlier exit date and reason are kept in their notes."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRehiring(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" icon={UserPlus} loading={busy} onClick={rehire}>Re-hire</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Joining date">
            {(p) => <Input {...p} type="date" value={rejoin.joined_on} onChange={(e) => setRejoin((r) => ({ ...r, joined_on: e.target.value }))} />}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select {...p} value={rejoin.status} onChange={(e) => setRejoin((r) => ({ ...r, status: e.target.value }))}>
                <option value="active">Active</option>
                <option value="on_probation">On probation</option>
              </Select>
            )}
          </Field>
          <Field label="Designation" className="sm:col-span-2">
            {(p) => <Input {...p} value={rejoin.designation ?? ''} onChange={(e) => setRejoin((r) => ({ ...r, designation: e.target.value }))} />}
          </Field>
        </div>
      </Modal>

      <Modal
        open={offboarding}
        onClose={() => setOffboarding(false)}
        title={`Offboard ${employee?.name}?`}
        description="This marks them as exited, reassigns their direct reports and cancels any pending leave."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOffboarding(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger" onClick={offboard} loading={busy} data-autofocus>Offboard</Button>
          </>
        }
      >
        <Alert tone="info">
          Their record and history are kept — nothing is deleted. You can see them again by
          filtering on the “Exited” status.
        </Alert>
      </Modal>
    </>
  );
}

const EDITABLE = ['first_name', 'last_name', 'email', 'phone', 'designation', 'department_id', 'manager_id',
  'employment_type', 'joined_on', 'date_of_birth', 'status', 'notes'];

/** Add an employee, or (with `employee`) change any of their details later. */
function EmployeeFormModal({ open, employee, departments, employees, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(employee?.id);
  const [form, setForm] = useState({ employment_type: 'full_time', status: 'active' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError(null);
    setForm(editing
      ? Object.fromEntries(EDITABLE.map((key) => [key, employee[key] ?? '']))
      : { employment_type: 'full_time', status: 'active' });
  }, [open, editing, employee]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      let response;
      if (editing) {
        // Send what changed; an emptied box clears that detail.
        const payload = {};
        for (const key of EDITABLE) {
          const before = employee[key] ?? '';
          if (String(form[key] ?? '') === String(before)) continue;
          payload[key] = form[key] === '' ? (['first_name', 'employment_type', 'status', 'joined_on'].includes(key) ? undefined : null) : form[key];
        }
        for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
        if (!Object.keys(payload).length) { onClose(); return; }
        response = await api.patch(`/hr/employees/${employee.id}`, payload);
        toast.success(`${response.data.name} updated`);
      } else {
        const payload = { ...form };
        for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];
        response = await api.post('/hr/employees', payload);
        toast.success(`${response.data.name} added`, {
          description: `Employee code ${response.data.employee_code}. Leave balances opened.`,
        });
      }
      onSaved(response.data);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = err.fieldErrors;
        if (Object.keys(fields).length) setErrors(fields);
        else setFormError(err.message);
      } else setFormError('Could not save that employee.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${employee.name}` : 'Add employee'}
      description={editing ? `Employee code ${employee.employee_code}.` : 'Only a first name is required. The employee code is generated for you.'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} icon={editing ? Pencil : Plus}>{editing ? 'Save changes' : 'Add employee'}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {formError && <Alert tone="critical">{formError}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={errors.first_name}>
            {(p) => <Input {...p} value={form.first_name ?? ''} onChange={set('first_name')} required data-autofocus />}
          </Field>
          <Field label="Last name">
            {(p) => <Input {...p} value={form.last_name ?? ''} onChange={set('last_name')} />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Work email" error={errors.email}>
            {(p) => <Input {...p} type="email" icon={Mail} value={form.email ?? ''} onChange={set('email')} />}
          </Field>
          <Field label="Phone">
            {(p) => <Input {...p} icon={Phone} value={form.phone ?? ''} onChange={set('phone')} />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Designation">
            {(p) => <Input {...p} placeholder="Senior Engineer" value={form.designation ?? ''} onChange={set('designation')} />}
          </Field>
          <Field label="Department" hint={departments.length ? undefined : 'No departments yet.'}>
            {(p) => (
              <Select {...p} value={form.department_id ?? ''} onChange={set('department_id')} disabled={!departments.length}>
                <option value="">Unassigned</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reports to">
            {(p) => (
              <Select {...p} value={form.manager_id ?? ''} onChange={set('manager_id')} disabled={!employees.length}>
                <option value="">No manager</option>
                {employees.filter((e) => e.status !== 'exited' && e.id !== employee?.id).map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Employment type">
            {(p) => (
              <Select {...p} value={form.employment_type} onChange={set('employment_type')}>
                {['full_time', 'part_time', 'contract', 'intern', 'consultant'].map((t) => (
                  <option key={t} value={t}>{label(t)}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Joined on">
            {(p) => <Input {...p} type="date" value={form.joined_on ?? ''} onChange={set('joined_on')} />}
          </Field>
          <Field label="Date of birth">
            {(p) => <Input {...p} type="date" value={form.date_of_birth ?? ''} onChange={set('date_of_birth')} />}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select {...p} value={form.status} onChange={set('status')}>
                <option value="active">Active</option>
                <option value="on_probation">On probation</option>
                {editing && <option value="on_notice">On notice</option>}
                {editing && <option value="on_leave">On long leave</option>}
              </Select>
            )}
          </Field>
        </div>

        <Field label="Notes">
          {(p) => <Textarea {...p} rows={2} value={form.notes ?? ''} onChange={set('notes')} />}
        </Field>
      </form>
    </Modal>
  );
}

/* ── people with a login but no employee record ──────────────────────────── */
function WorkspacePeople({ onAdded }) {
  const toast = useToast();
  const { user } = useWorkspace();
  const [people, setPeople] = useState([]);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/hr/employees/workspace-people').then((r) => setPeople(r.data)).catch(() => setPeople([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add(ids) {
    setBusy(true);
    try {
      const result = (await api.post('/hr/employees/from-people', { user_ids: ids })).data;
      toast.success(`${result.created + result.linked} added as employee${result.created + result.linked === 1 ? '' : 's'}`, {
        description: result.linked ? `${result.linked} matched an existing employee by email and were linked to it.` : 'They can now open the employee portal for payslips, leave and attendance.',
      });
      setOpen(false);
      load();
      onAdded?.();
    } catch (err) {
      toast.error('Could not add them', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  if (!people.length) return null;
  const me = people.find((p) => p.user_id === user?.id);
  return (
    <>
      <Alert
        tone="info"
        icon={UserPlus}
        title={`${people.length} ${people.length === 1 ? 'person' : 'people'} in your workspace ${people.length === 1 ? 'is' : 'are'} not an employee yet`}
        action={
          <div className="flex gap-1.5">
            {me && <Button size="xs" variant="ghost" loading={busy} onClick={() => add([me.user_id])}>Add me</Button>}
            <Button size="xs" variant="secondary" onClick={() => { setChosen(people.map((p) => p.user_id)); setOpen(true); }}>Review and add</Button>
          </div>
        }
      >
        {people.slice(0, 4).map((p) => p.name ?? p.email).join(', ')}{people.length > 4 ? ` and ${people.length - 4} more` : ''}. From now on, people who join the workspace are added here automatically (guests are not).
      </Alert>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add workspace people as employees"
        description="Each gets an employee record linked to their login. Someone whose email already matches an employee is linked to that record instead."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" icon={UserPlus} loading={busy} disabled={!chosen.length} onClick={() => add(chosen)}>Add {chosen.length}</Button></>}
      >
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {people.map((p) => (
            <li key={p.user_id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-2 py-2 hover:bg-[var(--surface-hover)]">
                <input type="checkbox" className="size-4" checked={chosen.includes(p.user_id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.user_id] : c.filter((x) => x !== p.user_id)))} />
                <Avatar name={p.name ?? p.email} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.name ?? p.email}{p.user_id === user?.id ? ' (you)' : ''}</span>
                  <span className="block truncate text-xs text-[var(--text-tertiary)]">{[p.email, p.title, p.roles.join(', ')].filter(Boolean).join(' · ')}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
