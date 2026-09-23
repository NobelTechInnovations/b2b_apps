'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Network, Users, Trash2, Pencil } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';

export default function DepartmentsClient() {
  const toast = useToast();
  const { can } = useWorkspace();

  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/hr/departments');
      setDepartments(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load departments.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/hr/employees', { query: { status: 'active', limit: 100 } })
      .then((r) => setEmployees(r.data)).catch(() => setEmployees([]));
  }, []);

  async function remove() {
    setBusy(true);
    try {
      await api.del(`/hr/departments/${deleting.id}`);
      toast.success(`${deleting.name} removed`);
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error('Could not remove that department', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  const total = departments.reduce((sum, d) => sum + d.headcount, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Departments"
        description="How your organisation is structured."
        actions={
          <Can permission="hr.departments.manage">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New department</Button>
          </Can>
        }
      />

      {error && <Alert tone="critical">{error}</Alert>}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 w-full" />)}
        </div>
      ) : departments.length === 0 ? (
        <Card>
          <EmptyState
            icon={Network}
            title="No departments yet"
            description="Group people into departments so headcount and reporting lines make sense."
            action={
              can('hr.departments.manage') && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                  Create a department
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            {departments.length} {departments.length === 1 ? 'department' : 'departments'} ·{' '}
            <span className="tabular">{total}</span> {total === 1 ? 'person' : 'people'} assigned
          </p>

          <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {departments.map((department) => (
              <Card key={department.id} className="panel-hover flex flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-md font-semibold">{department.name}</h3>
                    {department.code && (
                      <p className="mt-0.5 text-xs tabular text-[var(--text-tertiary)]">{department.code}</p>
                    )}
                  </div>
                  <Badge tone="neutral" size="sm">
                    <Users className="size-3" />
                    {department.headcount}
                  </Badge>
                </div>

                {department.description && (
                  <p className="mt-2.5 line-clamp-2 text-sm text-[var(--text-secondary)]">
                    {department.description}
                  </p>
                )}

                <div className="mt-auto pt-4">
                  {department.head_name ? (
                    <div className="flex items-center gap-2">
                      <Avatar name={department.head_name} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{department.head_name}</p>
                        <p className="text-xs text-[var(--text-tertiary)]">Department head</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--text-tertiary)]">No head assigned</p>
                  )}
                </div>

                <Can permission="hr.departments.manage">
                  <div className="mt-4 flex gap-1 border-t border-[var(--border-subtle)] pt-3">
                    <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setEditing(department)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      icon={Trash2}
                      onClick={() => setDeleting(department)}
                      disabled={department.headcount > 0}
                      title={department.headcount > 0 ? 'Move its people out first' : undefined}
                    >
                      Remove
                    </Button>
                  </div>
                </Can>
              </Card>
            ))}
          </div>
        </>
      )}

      <DepartmentModal
        open={creating || Boolean(editing)}
        department={editing}
        employees={employees}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={load}
      />

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        loading={busy}
        danger
        confirmLabel="Remove"
        title={`Remove ${deleting?.name}?`}
        description="The department is archived. Nobody is deleted, and history is kept."
      />
    </div>
  );
}

function DepartmentModal({ open, department, employees, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(
      department
        ? {
            name: department.name,
            code: department.code ?? '',
            head_employee_id: department.head_employee_id ?? '',
            description: department.description ?? '',
          }
        : {},
    );
    setError(null);
  }, [open, department]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form };
      for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];

      if (department) {
        await api.patch(`/hr/departments/${department.id}`, payload);
        toast.success(`${payload.name ?? department.name} updated`);
      } else {
        const response = await api.post('/hr/departments', payload);
        toast.success(`${response.data.name} created`);
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that department.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={department ? `Edit ${department.name}` : 'New department'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {department ? 'Save changes' : 'Create department'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="Name" required>
            {(p) => <Input {...p} value={form.name ?? ''} onChange={set('name')} required data-autofocus
              placeholder="Engineering" />}
          </Field>
          <Field label="Code">
            {(p) => <Input {...p} value={form.code ?? ''} onChange={set('code')} placeholder="ENG" />}
          </Field>
        </div>

        <Field label="Department head">
          {(p) => (
            <Select {...p} value={form.head_employee_id ?? ''} onChange={set('head_employee_id')}>
              <option value="">Not assigned</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          )}
        </Field>

        <Field label="Description">
          {(p) => <Textarea {...p} rows={2} value={form.description ?? ''} onChange={set('description')} />}
        </Field>
      </form>
    </Modal>
  );
}
