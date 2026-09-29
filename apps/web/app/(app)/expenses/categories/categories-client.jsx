'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Tags, Pencil } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Checkbox } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, PageHeader, Alert } from '@/components/ui/primitives';

export default function CategoriesClient() {
  const { can } = useWorkspace();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.get('/expenses/categories')).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load categories.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  const manage = can('expenses.policies.manage');

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Categories & limits"
        description="What people can claim for, which claims need a receipt, and monthly limits per person. Going over a limit does not block a claim — it flags it for the approver."
        actions={<Can permission="expenses.policies.manage"><Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New category</Button></Can>}
      />
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={6} columns={4} /> : (
        <Table>
          <THead>
            <tr><TH>Category</TH><TH>Receipt</TH><TH align="right">Monthly limit per person</TH><TH>Status</TH>{manage && <TH width="4rem" />}</tr>
          </THead>
          <TBody>
            {rows.map((c) => (
              <TR key={c.id} onClick={manage ? () => setEditing(c) : undefined}>
                <TD className="font-medium"><span className="flex items-center gap-2"><Tags className="size-3.5 text-[var(--text-tertiary)]" />{c.name}</span></TD>
                <TD>{c.requires_receipt ? <Badge size="sm" tone="brand">Required</Badge> : <span className="text-[var(--text-tertiary)]">Optional</span>}</TD>
                <TD align="right" numeric>{c.monthly_limit ? money(c.monthly_limit) : <span className="text-[var(--text-tertiary)]">No limit</span>}</TD>
                <TD>{c.active ? <Badge size="sm" tone="positive">Active</Badge> : <Badge size="sm">Archived</Badge>}</TD>
                {manage && <TD align="right"><Pencil className="inline size-3.5 text-[var(--text-tertiary)]" /></TD>}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {editing && <CategoryModal category={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function CategoryModal({ category, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !category.id;
  const [form, setForm] = useState({
    name: category.name ?? '', monthly_limit: category.monthly_limit ?? '',
    requires_receipt: category.requires_receipt ?? true, active: category.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      name: form.name,
      monthly_limit: form.monthly_limit === '' ? null : Number(form.monthly_limit).toFixed(2),
      requires_receipt: form.requires_receipt,
      active: form.active,
    };
    try {
      if (isNew) await api.post('/expenses/categories', payload);
      else await api.patch(`/expenses/categories/${category.id}`, payload);
      toast.success(isNew ? 'Category added' : 'Category saved');
      onClose();
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'New category' : `Edit ${category.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={submit}>Save</Button></>}
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <Field label="Name">{(p) => <Input {...p} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-autofocus />}</Field>
        <Field label="Monthly limit per person (₹)" hint="Leave empty for no limit">
          {(p) => <Input {...p} type="number" min="1" step="1" value={form.monthly_limit} onChange={(e) => setForm((f) => ({ ...f, monthly_limit: e.target.value }))} />}
        </Field>
        <Checkbox label="Receipt required" description="Claims cannot be submitted without one." checked={form.requires_receipt} onChange={(e) => setForm((f) => ({ ...f, requires_receipt: e.target.checked }))} />
        {!isNew && (
          <Checkbox label="Active" description="Archived categories stay on old claims but cannot be chosen for new expenses." checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
        )}
      </form>
    </Modal>
  );
}
