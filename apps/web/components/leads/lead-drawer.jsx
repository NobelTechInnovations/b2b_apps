'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Phone, MessageCircle, Mail, Pencil, Trash2, UserRoundCheck, PhoneCall, CalendarClock, Check, X,
  StickyNote, ArrowRightLeft, UserPlus, MapPin, Footprints, Users, RefreshCw, Plus,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea, Input } from '@/components/ui/input';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { Avatar, Badge, Alert, Skeleton } from '@/components/ui/primitives';
import {
  Chip, FollowupPicker, OUTCOME_LABEL, SOURCE_LABEL, StageBadge, customValue, dueLabel, telLink, whatsappLink,
} from './lead-kit';
import { LeadFormModal } from './lead-form';

const KIND_ICON = {
  call: PhoneCall, whatsapp: MessageCircle, email: Mail, meeting: Users, visit: Footprints, note: StickyNote, update: ArrowRightLeft, task: CalendarClock,
};
const FOLLOWUP_KINDS = [['call', 'Call'], ['whatsapp', 'WhatsApp'], ['meeting', 'Meeting'], ['visit', 'Visit'], ['email', 'Email'], ['task', 'Other']];
const SUGGEST_STAGE = { interested: 'open', not_interested: 'lost', wrong_number: 'lost' };

/**
 * One lead, worked from a side panel: ring them, log what happened, book the
 * next follow-up, and see everything that has happened so far.
 */
export function LeadDrawer({ leadId, meta, onClose, onChanged }) {
  const toast = useToast();
  const { can, hasApp } = useWorkspace();
  const [lead, setLead] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [converting, setConverting] = useState(false);

  const load = useCallback(async () => {
    if (!leadId) return;
    try {
      setLead((await api.get(`/leads/leads/${leadId}`)).data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this lead.');
    }
  }, [leadId]);

  useEffect(() => {
    setLead(null);
    setError(null);
    load();
  }, [load]);

  const changed = async () => {
    await load();
    onChanged?.();
  };

  async function patch(body, message) {
    try {
      await api.patch(`/leads/leads/${leadId}`, body);
      if (message) toast.success(message);
      await changed();
    } catch (err) {
      toast.error('Could not update the lead', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  async function remove() {
    try {
      await api.del(`/leads/leads/${leadId}`);
      toast.success('Lead deleted');
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error('Could not delete it', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  if (!leadId) return null;
  const fieldsByKey = new Map((meta?.fields ?? []).map((f) => [f.key, f]));

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={lead?.name ?? 'Loading…'}
      subtitle={lead ? [lead.company_name, lead.city].filter(Boolean).join(' · ') || null : null}
      badge={lead?.stage ? <StageBadge stage={lead.stage} /> : null}
      footer={lead && (
        <>
          <Can permission="leads.leads.delete">
            <Button variant="danger-ghost" icon={Trash2} onClick={() => setRemoving(true)}>Delete</Button>
          </Can>
          <div className="flex-1" />
          {hasApp('crm') && can('crm.leads.edit') && lead.status !== 'converted' && (
            <Button variant="secondary" icon={UserRoundCheck} onClick={() => setConverting(true)}>Convert to customer</Button>
          )}
          <Can permission="leads.leads.edit">
            <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>
          </Can>
        </>
      )}
    >
      {error && <Alert tone="critical">{error}</Alert>}
      {!lead && !error && <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>}
      {lead && (
        <div className="space-y-6">
          <ContactBar lead={lead} />

          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Stage"
              className="w-auto"
              value={lead.stage_id ?? ''}
              disabled={!can('leads.leads.edit')}
              onChange={(e) => patch({ stage_id: e.target.value }, `Moved to ${meta?.stages?.find((s) => s.id === e.target.value)?.name}`)}
            >
              {(meta?.stages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            {can('leads.leads.assign') ? (
              <Select
                aria-label="Owner"
                className="w-auto"
                value={lead.owner_user_id ?? ''}
                onChange={(e) => patch({ owner_user_id: e.target.value || null }, 'Owner changed')}
              >
                <option value="">Unassigned</option>
                {(meta?.team ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
              </Select>
            ) : (
              <span className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                <Avatar name={lead.owner?.name ?? '?'} size="xs" /> {lead.owner?.name ?? 'Unassigned'}
              </span>
            )}
            {lead.rating && <Badge size="sm" tone={{ hot: 'critical', warm: 'caution', cold: 'info' }[lead.rating]} dot>{lead.rating}</Badge>}
            {lead.status === 'converted' && <Badge size="sm" tone="positive">Customer in CRM</Badge>}
          </div>

          <Can permission="leads.calls.log">
            <CallLogger lead={lead} meta={meta} onLogged={changed} />
          </Can>

          <Followups lead={lead} onChanged={changed} />

          <section>
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Details</h3>
            <DetailGrid
              items={[
                { label: 'Phone', value: lead.phone },
                { label: 'Email', value: lead.email },
                { label: 'Company', value: lead.company_name },
                { label: 'City', value: lead.city },
                { label: 'Source', value: [SOURCE_LABEL[lead.source] ?? lead.source, lead.source_detail].filter(Boolean).join(' · ') },
                { label: 'Deal value', value: lead.estimated_value ? money(lead.estimated_value) : null },
                { label: 'Calls', value: lead.call_count ? `${lead.call_count} · last ${relativeTime(lead.last_call_at)}` : 'Not called yet' },
                { label: 'Added', value: relativeTime(lead.created_at) },
                ...[...fieldsByKey.values()].map((f) => ({ label: f.label, value: customValue(f, lead.custom?.[f.key]) })),
                ...(lead.tags?.length ? [{ label: 'Tags', value: lead.tags.join(', '), full: true }] : []),
                ...(lead.lost_reason ? [{ label: 'Lost because', value: lead.lost_reason, full: true }] : []),
                { label: 'Notes', value: lead.notes, full: true },
              ]}
            />
          </section>

          <Timeline lead={lead} onChanged={changed} />
        </div>
      )}

      <LeadFormModal open={editing} lead={lead} meta={meta} onClose={() => setEditing(false)} onSaved={changed} />
      <ConfirmModal
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={remove}
        danger
        confirmLabel="Delete lead"
        title={`Delete ${lead?.name}?`}
        description="It disappears from every list and its follow-ups are cancelled."
      />
      {converting && <ConvertModal lead={lead} onClose={() => setConverting(false)} onDone={changed} />}
    </Drawer>
  );
}

function ContactBar({ lead }) {
  const wa = whatsappLink(lead.phone, `Hi ${lead.first_name ?? ''},`.trim());
  return (
    <div className="flex flex-wrap items-center gap-2">
      {lead.phone && (
        <a href={telLink(lead.phone)}>
          <Button variant="primary" size="sm" icon={Phone}>Call {lead.phone}</Button>
        </a>
      )}
      {wa && (
        <a href={wa} target="_blank" rel="noreferrer">
          <Button variant="secondary" size="sm" icon={MessageCircle}>WhatsApp</Button>
        </a>
      )}
      {lead.email && (
        <a href={`mailto:${lead.email}`}>
          <Button variant="secondary" size="sm" icon={Mail}>Email</Button>
        </a>
      )}
      {!lead.phone && !lead.email && <span className="text-sm text-[var(--text-tertiary)]">No phone or email yet. Edit the lead to add one.</span>}
    </div>
  );
}

/* ── call update ──────────────────────────────────────────────────────────── */
function CallLogger({ lead, meta, onLogged }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState(null);
  const [note, setNote] = useState('');
  const [stageId, setStageId] = useState('');
  const [due, setDue] = useState(null);
  const [kind, setKind] = useState('call');
  const [busy, setBusy] = useState(false);

  function pick(value) {
    setOutcome(value);
    // A sensible next stage, which they can change.
    const want = SUGGEST_STAGE[value];
    if (want === 'lost') setStageId(meta?.stages?.find((s) => s.kind === 'lost')?.id ?? '');
    else if (want === 'open') setStageId(meta?.stages?.find((s) => /interest/i.test(s.name))?.id ?? '');
    else setStageId('');
    if (['no_answer', 'busy', 'switched_off'].includes(value) && !due) {
      const later = new Date(Date.now() + 2 * 3600_000);
      later.setMinutes(0, 0, 0);
      setDue(later.toISOString());
    }
  }

  async function save() {
    if (!outcome) return;
    setBusy(true);
    try {
      await api.post(`/leads/leads/${lead.id}/calls`, {
        outcome,
        note: note.trim() || null,
        stage_id: stageId && stageId !== lead.stage_id ? stageId : undefined,
        followup: due ? { due_at: due, kind } : undefined,
      });
      toast.success('Call logged', { description: due ? 'Next follow-up booked.' : undefined });
      setOutcome(null);
      setNote('');
      setStageId('');
      setDue(null);
      await onLogged();
    } catch (err) {
      toast.error('Could not log the call', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-xl)] border border-[var(--border-default)] bg-[var(--surface-sunken)] p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><PhoneCall className="size-4 text-[var(--text-brand)]" /> Call update</h3>
      <div className="flex flex-wrap gap-1.5">
        {(meta?.outcomes ?? Object.entries(OUTCOME_LABEL).map(([value, label]) => ({ value, label }))).map((o) => (
          <Chip key={o.value} active={outcome === o.value} onClick={() => pick(o.value)}>{OUTCOME_LABEL[o.value] ?? o.label}</Chip>
        ))}
      </div>
      {outcome && (
        <div className="animate-fade mt-4 space-y-3">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did they say?" aria-label="Call note" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Move to stage">
              {(p) => (
                <Select {...p} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                  <option value="">Keep {meta?.stages?.find((s) => s.id === lead.stage_id)?.name ?? 'current stage'}</option>
                  {(meta?.stages ?? []).filter((s) => s.id !== lead.stage_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Next follow-up by">
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value)}>
                  {FOLLOWUP_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <FollowupPicker value={due} onChange={setDue} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOutcome(null)}>Cancel</Button>
            <Button variant="primary" size="sm" icon={Check} loading={busy} onClick={save}>Save call</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ── follow-ups ───────────────────────────────────────────────────────────── */
function Followups({ lead, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(null);

  async function act(followup, action, body) {
    try {
      if (action === 'move') await api.patch(`/leads/followups/${followup.id}`, body);
      else await api.post(`/leads/followups/${followup.id}/${action}`, body ?? {});
      toast.success(action === 'done' ? 'Marked done' : action === 'cancel' ? 'Follow-up cancelled' : 'Rescheduled');
      setMoving(null);
      await onChanged();
    } catch (err) {
      toast.error('Could not update the follow-up', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">Follow-ups</h3>
        <Can permission="leads.followups.create">
          <Button variant="ghost" size="xs" icon={Plus} onClick={() => setAdding(true)}>Add</Button>
        </Can>
      </div>
      {lead.followups.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-4 text-center text-sm text-[var(--text-tertiary)]">
          Nothing booked. Log a call or add a follow-up so this lead is not forgotten.
        </p>
      ) : (
        <ul className="space-y-2">
          {lead.followups.map((f) => {
            const due = dueLabel(f.due_at);
            const Icon = KIND_ICON[f.kind] ?? CalendarClock;
            return (
              <li key={f.id} className={cn('rounded-[var(--radius-lg)] border px-3 py-2.5', due.overdue ? 'border-[rgb(239_68_68/0.35)] bg-[rgb(239_68_68/0.04)]' : 'border-[var(--border-subtle)]')}>
                <div className="flex items-start gap-2.5">
                  <Icon className={cn('mt-0.5 size-4 shrink-0', due.overdue ? 'text-[var(--color-critical-500)]' : 'text-[var(--text-tertiary)]')} />
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm font-medium', due.overdue && 'text-[var(--color-critical-600)]')}>
                      {due.text}{due.overdue ? ' · overdue' : ''}
                    </p>
                    <p className="text-xs text-[var(--text-tertiary)]">{f.subject}{f.for?.name ? ` · ${f.for.name}` : ''}</p>
                    {f.body && <p className="mt-1 whitespace-pre-line text-sm text-[var(--text-secondary)]">{f.body}</p>}
                  </div>
                  {can('leads.followups.edit') && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label="Mark done" title="Mark done" onClick={() => act(f, 'done')}><Check className="size-4" /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Reschedule" title="Reschedule" onClick={() => setMoving(f)}><RefreshCw className="size-3.5" /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Cancel follow-up" title="Cancel" onClick={() => act(f, 'cancel')}><X className="size-4" /></Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <FollowupModal open={adding} title="Add a follow-up" onClose={() => setAdding(false)} onSave={async (body) => {
        await api.post(`/leads/leads/${lead.id}/followups`, body);
        toast.success('Follow-up booked');
        setAdding(false);
        await onChanged();
      }} />
      <FollowupModal open={Boolean(moving)} title="Reschedule" initial={moving} onClose={() => setMoving(null)} onSave={(body) => act(moving, 'move', body)} />
    </section>
  );
}

export function FollowupModal({ open, title, initial, onClose, onSave }) {
  const [due, setDue] = useState(null);
  const [kind, setKind] = useState('call');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (!open) return;
    setDue(null);
    setKind(initial?.kind ?? 'call');
    setNote(initial?.body ?? '');
    setProblem(null);
  }, [open, initial]);
  async function save() {
    if (!due) { setProblem('Choose when.'); return; }
    setBusy(true);
    try {
      await onSave({ due_at: due, kind, note: note.trim() || null });
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not save it.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        {problem && <Alert tone="critical">{problem}</Alert>}
        <Field label="When">{() => <FollowupPicker value={due} onChange={setDue} allowNone={false} />}</Field>
        <Field label="How">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value)}>
              {FOLLOWUP_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Note">{(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Share the brochure, confirm the visit…" />}</Field>
      </div>
    </Modal>
  );
}

/* ── history ──────────────────────────────────────────────────────────────── */
function Timeline({ lead, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [text, setText] = useState('');
  const [kind, setKind] = useState('note');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.post(`/leads/leads/${lead.id}/notes`, { body: text.trim(), kind });
      setText('');
      await onChanged();
    } catch (err) {
      toast.error('Could not add that', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">History</h3>
      {can('leads.leads.edit') && (
        <div className="mb-4 space-y-2">
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note, or record a WhatsApp chat, meeting or visit…" aria-label="Add to history" />
          <div className="flex items-center justify-end gap-2">
            <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto" aria-label="Kind">
              <option value="note">Note</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option>
              <option value="meeting">Meeting</option><option value="visit">Visit</option>
            </Select>
            <Button size="sm" variant="secondary" loading={busy} disabled={!text.trim()} onClick={add}>Add</Button>
          </div>
        </div>
      )}
      {lead.timeline.length === 0 ? (
        <p className="text-sm text-[var(--text-tertiary)]">Nothing yet.</p>
      ) : (
        <ol className="space-y-3">
          {lead.timeline.map((a) => {
            const Icon = KIND_ICON[a.kind] ?? StickyNote;
            return (
              <li key={a.id} className="flex gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-sunken)]">
                  <Icon className="size-3.5 text-[var(--text-secondary)]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{a.subject}</span>
                    {a.kind === 'call' && a.duration_minutes ? <span className="text-[var(--text-tertiary)]"> · {a.duration_minutes} min</span> : null}
                    {a.canceled_at && <span className="text-[var(--text-tertiary)]"> · cancelled</span>}
                  </p>
                  {a.body && <p className="mt-0.5 whitespace-pre-line text-sm text-[var(--text-secondary)]">{a.body}</p>}
                  <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{a.by?.name ?? 'Automatically'} · {relativeTime(a.completed_at ?? a.created_at)}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ── into CRM ─────────────────────────────────────────────────────────────── */
function ConvertModal({ lead, onClose, onDone }) {
  const toast = useToast();
  const [createDeal, setCreateDeal] = useState(true);
  const [title, setTitle] = useState(`${lead.company_name ?? lead.name} opportunity`);
  const [value, setValue] = useState(lead.estimated_value ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  async function submit() {
    setBusy(true);
    try {
      const result = (await api.post(`/crm/leads/${lead.id}/convert`, {
        create_deal: createDeal, deal_title: createDeal ? title : undefined, deal_value: createDeal && value ? Number(value).toFixed(2) : undefined,
      })).data;
      const won = (await api.get('/leads/meta')).data.stages.find((s) => s.kind === 'won');
      if (won && lead.stage_id !== won.id) await api.patch(`/leads/leads/${lead.id}`, { stage_id: won.id });
      toast.success('Converted', { description: result.deal_id ? 'Contact, company and deal created in CRM.' : 'Contact created in CRM.' });
      onClose();
      await onDone();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not convert this lead.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Convert ${lead.name}`} description="Creates the customer in CRM and marks the lead won."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={UserPlus} loading={busy} onClick={submit}>Convert</Button></>}>
      <div className="space-y-4">
        {problem && <Alert tone="critical">{problem}</Alert>}
        <label className="flex items-center gap-2 text-base">
          <input type="checkbox" checked={createDeal} onChange={(e) => setCreateDeal(e.target.checked)} className="size-4" /> Also open a deal
        </label>
        {createDeal && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Deal title">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <Field label="Deal value (₹)">{(p) => <Input {...p} type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
          </div>
        )}
        {lead.city && <p className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]"><MapPin className="size-3" />{lead.city}</p>}
      </div>
    </Modal>
  );
}
