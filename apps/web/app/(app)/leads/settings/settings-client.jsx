'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, ArrowUp, ArrowDown, Pencil, Trash2, ListPlus, Layers } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Checkbox, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Card, CardHeader, PageHeader, Alert, Badge, Skeleton } from '@/components/ui/primitives';
import { FIELD_TYPE_LABEL, STAGE_COLORS, StageBadge, forgetLeadsMeta } from '@/components/leads/lead-kit';
import { tintFor } from '@/lib/app-theme';

export default function SettingsClient() {
  const toast = useToast();
  const [fields, setFields] = useState(null);
  const [stages, setStages] = useState(null);
  const [error, setError] = useState(null);
  const [fieldModal, setFieldModal] = useState(null);
  const [stageModal, setStageModal] = useState(null);
  const [removingStage, setRemovingStage] = useState(null);

  const load = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([api.get('/leads/fields'), api.get('/leads/stages')]);
      setFields(f.data);
      setStages(s.data);
      forgetLeadsMeta();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load settings.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const fail = (err) => toast.error('That did not work', { description: err instanceof ApiError ? err.message : undefined });

  async function move(kind, list, index, delta) {
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    try {
      await api.put(`/leads/${kind}/order`, { ids: next.map((x) => x.id) });
      load();
    } catch (err) { fail(err); }
  }

  async function removeField(field) {
    try {
      await api.del(`/leads/fields/${field.id}`);
      toast.success(`${field.label} removed`, { description: 'Values already entered stay on each lead.' });
      load();
    } catch (err) { fail(err); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Fields & stages" description="Make the lead form yours: the questions your team asks, and the steps a lead goes through." />
      {error && <Alert tone="critical">{error}</Alert>}

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><ListPlus className="size-4" /> Lead fields</span>}
          description="Shown on the lead form, in imports and in survey forms. Name, phone, email, company and city are always there."
          action={<Button size="sm" variant="primary" icon={Plus} onClick={() => setFieldModal({})}>Add field</Button>}
        />
        {!fields ? <div className="p-4"><Skeleton className="h-16" /></div> : fields.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-[var(--text-tertiary)]">No extra fields yet. Add the things you always ask — budget, property type, course, visit date…</p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {fields.map((f, i) => (
              <li key={f.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {f.label}
                    <Badge size="sm">{FIELD_TYPE_LABEL[f.type]}</Badge>
                    {f.required && <Badge size="sm" tone="caution">required</Badge>}
                    {f.show_in_list && <Badge size="sm" tone="info">in list</Badge>}
                  </p>
                  {f.options?.length > 0 && <p className="truncate text-xs text-[var(--text-tertiary)]">{f.options.join(' · ')}</p>}
                </div>
                <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move('fields', fields, i, -1)}><ArrowUp className="size-4" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === fields.length - 1} onClick={() => move('fields', fields, i, 1)}><ArrowDown className="size-4" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Edit ${f.label}`} onClick={() => setFieldModal(f)}><Pencil className="size-3.5" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Remove ${f.label}`} onClick={() => removeField(f)}><Trash2 className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><Layers className="size-4" /> Stages</span>}
          description="Open stages are still being worked; won and lost close the lead."
          action={<Button size="sm" variant="primary" icon={Plus} onClick={() => setStageModal({})}>Add stage</Button>}
        />
        {!stages ? <div className="p-4"><Skeleton className="h-16" /></div> : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {stages.map((s, i) => (
              <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <StageBadge stage={s} />
                  <span className="text-xs text-[var(--text-tertiary)]">{s.kind === 'open' ? 'open' : s.kind === 'won' ? 'closes as won' : 'closes as lost'} · {s.lead_count} lead{s.lead_count === 1 ? '' : 's'}</span>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move('stages', stages, i, -1)}><ArrowUp className="size-4" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === stages.length - 1} onClick={() => move('stages', stages, i, 1)}><ArrowDown className="size-4" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => setStageModal(s)}><Pencil className="size-3.5" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => setRemovingStage(s)}><Trash2 className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <FieldModal field={fieldModal} onClose={() => setFieldModal(null)} onSaved={() => { setFieldModal(null); load(); }} />
      <StageModal stage={stageModal} onClose={() => setStageModal(null)} onSaved={() => { setStageModal(null); load(); }} />
      <RemoveStageModal stage={removingStage} stages={stages ?? []} onClose={() => setRemovingStage(null)} onDone={() => { setRemovingStage(null); load(); }} />
    </div>
  );
}

function FieldModal({ field, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(field?.id);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (!field) return;
    setForm(editing ? { label: field.label, options: field.options.join('\n'), required: field.required, show_in_list: field.show_in_list, type: field.type } : { type: 'text', options: '', required: false, show_in_list: false });
    setProblem(null);
  }, [field, editing]);
  if (!field) return null;
  const hasOptions = ['select', 'multi_select'].includes(form.type);

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const options = hasOptions ? form.options.split('\n').map((o) => o.trim()).filter(Boolean) : undefined;
      const body = { label: form.label?.trim(), required: form.required, show_in_list: form.show_in_list, ...(options ? { options } : {}) };
      if (editing) await api.patch(`/leads/fields/${field.id}`, body);
      else await api.post('/leads/fields', { ...body, type: form.type });
      toast.success(editing ? 'Field saved' : 'Field added');
      onSaved();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not save the field.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${field.label}` : 'Add a lead field'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.label?.trim()} onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        {problem && <Alert tone="critical">{problem}</Alert>}
        <Field label="Label" required>{(p) => <Input {...p} value={form.label ?? ''} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="Budget" data-autofocus />}</Field>
        <Field label="Type" hint={editing ? 'The type cannot change once leads have values.' : undefined}>
          {(p) => (
            <Select {...p} value={form.type} disabled={editing} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
              {Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          )}
        </Field>
        {hasOptions && (
          <Field label="Options" hint="One per line.">{(p) => <Textarea {...p} rows={4} value={form.options} onChange={(e) => setForm((f) => ({ ...f, options: e.target.value }))} placeholder={'Flat\nVilla\nPlot'} />}</Field>
        )}
        <Checkbox checked={form.required ?? false} onChange={(e) => setForm((f) => ({ ...f, required: e.target.checked }))} label="Required" description="People must fill it when adding a lead by hand. Imports never fail over it." />
        <Checkbox checked={form.show_in_list ?? false} onChange={(e) => setForm((f) => ({ ...f, show_in_list: e.target.checked }))} label="Show as a column in the leads list" />
      </div>
    </Modal>
  );
}

function StageModal({ stage, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(stage?.id);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (!stage) return;
    setForm(editing ? { name: stage.name, color: stage.color, kind: stage.kind } : { name: '', color: 'blue', kind: 'open' });
    setProblem(null);
  }, [stage, editing]);
  if (!stage) return null;
  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const body = { name: form.name.trim(), color: form.color, kind: form.kind };
      if (editing) await api.patch(`/leads/stages/${stage.id}`, body);
      else await api.post('/leads/stages', body);
      toast.success(editing ? 'Stage saved' : 'Stage added');
      onSaved();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not save the stage.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${stage.name}` : 'Add a stage'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.name?.trim()} onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        {problem && <Alert tone="critical">{problem}</Alert>}
        <Field label="Name" required>{(p) => <Input {...p} value={form.name ?? ''} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Site visit" data-autofocus />}</Field>
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
              <option value="open">Open — still being worked</option>
              <option value="won">Won — they bought</option>
              <option value="lost">Lost — not going ahead</option>
            </Select>
          )}
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium">Colour</p>
          <div className="flex flex-wrap gap-1.5">
            {STAGE_COLORS.map((c) => (
              <button key={c} type="button" aria-label={c} onClick={() => setForm((f) => ({ ...f, color: c }))}
                className={cn('rounded-full px-2.5 py-1 text-xs font-medium ring-offset-2', tintFor(c), form.color === c && 'ring-2 ring-[var(--color-brand-500)]')}>
                {form.name?.trim() || 'Stage'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RemoveStageModal({ stage, stages, onClose, onDone }) {
  const toast = useToast();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  useEffect(() => { setTarget(''); setProblem(null); }, [stage]);
  if (!stage) return null;
  async function remove() {
    setBusy(true);
    try {
      await api.del(`/leads/stages/${stage.id}`, { body: { move_to: target } });
      toast.success(`${stage.name} removed`);
      onDone();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not remove it.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Remove ${stage.name}?`} description={stage.lead_count ? `${stage.lead_count} lead${stage.lead_count === 1 ? ' is' : 's are'} in this stage. Where should they go?` : 'Choose where any leads in it should go.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={!target} onClick={remove}>Remove stage</Button></>}>
      <div className="space-y-3">
        {problem && <Alert tone="critical">{problem}</Alert>}
        <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Move leads to">
          <option value="">Move its leads to…</option>
          {stages.filter((s) => s.id !== stage.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </div>
    </Modal>
  );
}
