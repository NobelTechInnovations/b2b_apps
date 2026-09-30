'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, ListTree, Pencil } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useOptions } from '@/components/data/resource-page';
import { LineItems, ProductPicker } from '@/components/data/line-items';
import { Table, THead, TBody, TH, TR, TD, TableSkeleton } from '@/components/ui/table';
import { Badge, Card, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

export default function BomClient() {
  const { can } = useWorkspace();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    api.get('/manufacturing/boms').then((r) => setRows(r.data)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function open(row) {
    const r = await api.get(`/manufacturing/boms/${row.id}`);
    setEditing(r.data);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bills of materials"
        description="The recipe for each product: which components, how many, and how long it takes. Cost updates as component costs change."
        actions={<Can permission="manufacturing.bom.manage"><Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New recipe</Button></Can>}
      />
      {error && <Alert tone="critical">{error}</Alert>}
      {!rows ? <TableSkeleton rows={5} columns={5} /> : rows.length === 0 ? (
        <Card><EmptyState icon={ListTree} title="No recipes yet" description="Say what goes into a product and manufacturing orders will consume it automatically." action={can('manufacturing.bom.manage') && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New recipe</Button>} /></Card>
      ) : (
        <Table>
          <THead><tr><TH>Product</TH><TH>Recipe</TH><TH align="right">Makes</TH><TH align="right">Components</TH><TH align="right">Component cost</TH><TH>Work center</TH><TH /></tr></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id} onClick={() => open(r)}>
                <TD className="font-medium">{r.product_name}</TD>
                <TD className="text-[var(--text-secondary)]">{r.name}</TD>
                <TD align="right" numeric>{Number(r.quantity)} {r.uom}</TD>
                <TD align="right" numeric>{r.component_count}</TD>
                <TD align="right" numeric>{money(r.component_cost)}</TD>
                <TD className="text-[var(--text-secondary)]">{r.work_center_name ?? '—'}</TD>
                <TD>{!r.active && <Badge size="sm">Archived</Badge>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {editing && <BomForm bom={editing} readOnly={!can('manufacturing.bom.manage')} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function BomForm({ bom, readOnly, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !bom.id;
  const workCenters = useOptions('/manufacturing/work-centers');
  const [product, setProduct] = useState(bom.product_id ? { id: bom.product_id, name: bom.product_name } : null);
  const [form, setForm] = useState({
    name: bom.name ?? '', quantity: String(bom.quantity ?? 1), work_center_id: bom.work_center_id ?? '', hours: String(bom.hours ?? 0),
    notes: bom.notes ?? '', active: bom.active ?? true,
  });
  const [lines, setLines] = useState(bom.lines?.map((l) => ({ product_id: l.product_id, product_name: l.product_name, quantity: String(Number(l.quantity)) })) ?? [{ quantity: 1 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit() {
    setBusy(true);
    setError(null);
    const body = {
      name: form.name, quantity: Number(form.quantity), work_center_id: form.work_center_id || null, hours: Number(form.hours || 0),
      notes: form.notes, active: form.active,
      lines: lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) })),
    };
    try {
      if (isNew) await api.post('/manufacturing/boms', { ...body, product_id: product?.id });
      else await api.patch(`/manufacturing/boms/${bom.id}`, body);
      toast.success(isNew ? 'Recipe created' : 'Recipe saved');
      onClose();
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="full" title={isNew ? 'New bill of materials' : `${bom.product_name} recipe`}
      description={bom.unit_cost ? `Component cost ${money(bom.component_cost)} per batch · ${money(bom.unit_cost)} per unit` : undefined}
      footer={readOnly ? <Button onClick={onClose}>Close</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={isNew ? Plus : Pencil} loading={busy} disabled={!product} onClick={submit}>{isNew ? 'Create' : 'Save'}</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Product made" required className="sm:col-span-2">
            {() => (isNew ? <ProductPicker value={product?.id} label={product?.name} onPick={setProduct} autoFocus /> : <Input value={bom.product_name} disabled />)}
          </Field>
          <Field label="Batch makes">{(p) => <Input {...p} type="number" min="0" step="any" value={form.quantity} onChange={set('quantity')} disabled={readOnly} />}</Field>
          <Field label="Hours per batch">{(p) => <Input {...p} type="number" min="0" step="0.25" value={form.hours} onChange={set('hours')} disabled={readOnly} />}</Field>
          <Field label="Recipe name" className="sm:col-span-2">{(p) => <Input {...p} value={form.name} onChange={set('name')} placeholder="Standard" disabled={readOnly} />}</Field>
          <Field label="Work center" className="sm:col-span-2">{(p) => <Select {...p} value={form.work_center_id} onChange={set('work_center_id')} disabled={readOnly}><option value="">—</option>{workCenters.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Components per batch</p>
          <LineItems lines={lines} onChange={setLines} showPrice={false} showTax={false} />
        </div>
        <Field label="Notes">{(p) => <Textarea {...p} rows={2} value={form.notes} onChange={set('notes')} disabled={readOnly} />}</Field>
        {!isNew && <Checkbox label="Active" description="Only active recipes are used for new orders." checked={form.active} onChange={set('active')} disabled={readOnly} />}
      </div>
    </Modal>
  );
}
