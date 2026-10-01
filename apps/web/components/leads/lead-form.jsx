'use client';

import { useEffect, useState } from 'react';
import { Plus, Save, Phone, Mail, Building2, MapPin } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Alert } from '@/components/ui/primitives';
import { CustomFieldInput, FollowupPicker, SOURCE_LABEL } from './lead-kit';

const MANUAL_SOURCES = ['manual', 'walk_in', 'cold_call', 'referral', 'website', 'whatsapp', 'event', 'campaign', 'partner'];

/**
 * Add or edit a lead. Its form is the workspace's: the standard details plus
 * every field the workspace added, in their order.
 */
export function LeadFormModal({ open, lead, meta, onClose, onSaved, onOpenExisting }) {
  const toast = useToast();
  const { can, user } = useWorkspace();
  const editing = Boolean(lead?.id);
  const [form, setForm] = useState({});
  const [followup, setFollowup] = useState(null);
  const [errors, setErrors] = useState({});
  const [problem, setProblem] = useState(null);
  const [twin, setTwin] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setProblem(null);
    setTwin(null);
    setFollowup(null);
    setForm(editing ? {
      full_name: lead.name ?? '', phone: lead.phone ?? '', email: lead.email ?? '', company_name: lead.company_name ?? '',
      city: lead.city ?? '', stage_id: lead.stage_id ?? '', owner_user_id: lead.owner_user_id ?? '', source: lead.source ?? 'manual',
      rating: lead.rating ?? '', estimated_value: lead.estimated_value ?? '', tags: (lead.tags ?? []).join(', '),
      notes: lead.notes ?? '', job_title: lead.job_title ?? '', custom: { ...(lead.custom ?? {}) },
    } : {
      source: 'manual', stage_id: meta?.stages?.find((s) => s.kind === 'open')?.id ?? '', owner_user_id: user?.id ?? '', custom: {},
    });
  }, [open, editing, lead, meta, user]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setCustom = (key, value) => setForm((f) => ({ ...f, custom: { ...f.custom, [key]: value } }));
  const canAssign = can('leads.leads.assign');

  async function submit(event, allowDuplicate = false) {
    event?.preventDefault();
    setBusy(true);
    setErrors({});
    setProblem(null);
    try {
      const payload = {
        full_name: form.full_name?.trim() || undefined,
        phone: form.phone?.trim() || null,
        email: form.email?.trim() || null,
        company_name: form.company_name?.trim() || null,
        job_title: form.job_title?.trim() || null,
        city: form.city?.trim() || null,
        source: form.source || undefined,
        rating: form.rating || null,
        estimated_value: form.estimated_value === '' || form.estimated_value === undefined ? null : Number(form.estimated_value).toFixed(2),
        tags: String(form.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        notes: form.notes?.trim() || null,
        custom: form.custom,
        stage_id: form.stage_id || undefined,
      };
      if (canAssign) payload.owner_user_id = form.owner_user_id || null;
      if (editing && !payload.full_name) delete payload.full_name;
      let saved;
      if (editing) {
        if (!canAssign) delete payload.owner_user_id;
        saved = (await api.patch(`/leads/leads/${lead.id}`, payload)).data;
        toast.success('Lead updated');
      } else {
        if (followup) payload.followup = { due_at: followup, kind: 'call' };
        if (allowDuplicate) payload.allow_duplicate = true;
        saved = (await api.post('/leads/leads', payload)).data;
        toast.success(`${saved.name} added`, { description: followup ? 'Follow-up booked.' : undefined });
      }
      onSaved?.(saved);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.details?.code === 'duplicate_lead') {
        setTwin(error.details);
      } else if (error instanceof ApiError) {
        const fields = error.fieldErrors;
        if (Object.keys(fields).length) setErrors(fields);
        setProblem(error.message);
      } else setProblem('Could not save that lead.');
    } finally {
      setBusy(false);
    }
  }

  const fields = meta?.fields ?? [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={editing ? `Edit ${lead.name}` : 'New lead'}
      description={editing ? null : 'A name or a phone number is enough to start.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={(e) => submit(e)} loading={busy} icon={editing ? Save : Plus}>{editing ? 'Save' : 'Add lead'}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {twin && (
          <Alert
            tone="caution"
            title="This person is already a lead"
            action={
              <div className="flex gap-1.5">
                {twin.lead_id && <Button size="xs" variant="secondary" onClick={() => { onClose(); onOpenExisting?.(twin.lead_id); }}>Open {twin.name ?? 'it'}</Button>}
                <Button size="xs" variant="ghost" onClick={(e) => submit(e, true)}>Add anyway</Button>
              </div>
            }
          >
            {twin.lead_id ? 'Same phone number or email.' : 'Someone else on your team owns a lead with this phone number or email.'}
          </Alert>
        )}
        {problem && !twin && <Alert tone="critical">{problem}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.full_name}>
            {(p) => <Input {...p} value={form.full_name ?? ''} onChange={set('full_name')} data-autofocus placeholder="Ravi Kumar" />}
          </Field>
          <Field label="Phone" error={errors.phone}>
            {(p) => <Input {...p} type="tel" icon={Phone} value={form.phone ?? ''} onChange={set('phone')} placeholder="98765 43210" />}
          </Field>
          <Field label="Email" error={errors.email}>
            {(p) => <Input {...p} type="email" icon={Mail} value={form.email ?? ''} onChange={set('email')} />}
          </Field>
          <Field label="Company">
            {(p) => <Input {...p} icon={Building2} value={form.company_name ?? ''} onChange={set('company_name')} />}
          </Field>
          <Field label="City">
            {(p) => <Input {...p} icon={MapPin} value={form.city ?? ''} onChange={set('city')} />}
          </Field>
          <Field label="Stage">
            {(p) => (
              <Select {...p} value={form.stage_id ?? ''} onChange={set('stage_id')}>
                {(meta?.stages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </Field>
          {canAssign && (
            <Field label="Owner" hint="Who calls this lead.">
              {(p) => (
                <Select {...p} value={form.owner_user_id ?? ''} onChange={set('owner_user_id')}>
                  <option value="">Unassigned</option>
                  {(meta?.team ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
                </Select>
              )}
            </Field>
          )}
          <Field label="Source">
            {(p) => (
              <Select {...p} value={form.source ?? 'manual'} onChange={set('source')}>
                {[...new Set([...MANUAL_SOURCES, form.source].filter(Boolean))].map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] ?? s}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Rating">
            {(p) => (
              <Select {...p} value={form.rating ?? ''} onChange={set('rating')}>
                <option value="">Not rated</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
              </Select>
            )}
          </Field>
          <Field label="Deal value (₹)">
            {(p) => <Input {...p} type="number" min="0" step="1" value={form.estimated_value ?? ''} onChange={set('estimated_value')} />}
          </Field>
        </div>

        {fields.length > 0 && (
          <div className="grid gap-4 border-t border-[var(--border-subtle)] pt-4 sm:grid-cols-2">
            {fields.map((field) => (
              field.type === 'checkbox' ? (
                <div key={field.id} className="flex items-end pb-1.5">
                  <CustomFieldInput field={field} value={form.custom?.[field.key]} onChange={(value) => setCustom(field.key, value)} />
                </div>
              ) : (
                <Field
                  key={field.id}
                  label={field.label}
                  required={field.required}
                  error={errors[`custom.${field.key}`]}
                  className={field.type === 'long_text' || field.type === 'multi_select' ? 'sm:col-span-2' : undefined}
                >
                  {(p) => <CustomFieldInput {...p} field={field} value={form.custom?.[field.key]} onChange={(value) => setCustom(field.key, value)} />}
                </Field>
              )
            ))}
          </div>
        )}

        <div className="grid gap-4 border-t border-[var(--border-subtle)] pt-4">
          <Field label="Tags" hint="Separate with commas.">
            {(p) => <Input {...p} value={form.tags ?? ''} onChange={set('tags')} placeholder="expo, 2bhk" />}
          </Field>
          <Field label="Notes">
            {(p) => <Textarea {...p} rows={3} value={form.notes ?? ''} onChange={set('notes')} placeholder="What do they need?" />}
          </Field>
          {!editing && (
            <Field label="First follow-up">
              {() => <FollowupPicker value={followup} onChange={setFollowup} />}
            </Field>
          )}
        </div>
      </form>
    </Modal>
  );
}
