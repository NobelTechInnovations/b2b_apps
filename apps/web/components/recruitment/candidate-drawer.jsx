'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Mail, Phone, CalendarPlus, Star, BadgeCheck, UserPlus, History, Send, Trash2, FileText, ArrowRight, XCircle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { money, date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { titleCase } from '@/lib/people';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Drawer, DetailGrid } from '@/components/data/drawer';
import { SourceTaskButton } from '@/components/tasks/source-task-button';
import { Avatar, Badge, Alert } from '@/components/ui/primitives';

export const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];
export const STAGE_TONE = {
  applied: 'info', screening: 'brand', interview: 'caution', offer: 'brand', hired: 'positive', rejected: 'neutral',
};
const OFFER_TONE = { proposed: 'caution', approved: 'brand', accepted: 'positive', declined: 'critical' };
const RECOMMENDATION = { strong_yes: 'Strong yes', yes: 'Yes', no: 'No', strong_no: 'Strong no' };

export const candidateName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ');

export function CandidateDrawer({ candidateId, people, nameOf, onClose, onChanged }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [modal, setModal] = useState(null); // 'interview' | 'offer' | 'hire' | 'reject' | 'delete' | {feedback}

  const load = useCallback(async () => {
    try {
      setC((await api.get(`/recruitment/candidates/${candidateId}`)).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that candidate.');
    }
  }, [candidateId]);

  useEffect(() => { setC(null); setError(null); load(); }, [load]);

  const refresh = async () => { await load(); onChanged?.(); };

  async function move(stage, reason) {
    try {
      await api.post(`/recruitment/candidates/${candidateId}/stage`, { stage, reason });
      toast.success(`Moved to ${titleCase(stage)}`);
      setModal(null);
      await refresh();
    } catch (err) {
      toast.error('Could not move the candidate', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  async function addNote(event) {
    event.preventDefault();
    if (!note.trim()) return;
    try {
      await api.post(`/recruitment/candidates/${candidateId}/notes`, { body: note });
      setNote('');
      await load();
    } catch (err) {
      toast.error('Note not saved', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  async function remove() {
    try {
      await api.del(`/recruitment/candidates/${candidateId}`);
      toast.success('Candidate removed');
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error('Could not remove', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const closed = c && ['hired', 'rejected'].includes(c.stage);
  const next = c && { applied: 'screening', screening: 'interview', interview: 'offer' }[c.stage];

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={c ? candidateName(c) : 'Loading…'}
      subtitle={c ? `${c.job_title ?? 'Candidate'} · applied ${relativeTime(c.created_at)} via ${titleCase(c.source)}` : undefined}
      badge={c && <Badge size="sm" tone={STAGE_TONE[c.stage]}>{titleCase(c.stage)}</Badge>}
      footer={c && !closed && (
        <>
          <Can permission="recruitment.candidates.edit">
            <Button variant="danger-ghost" icon={Trash2} onClick={() => setModal('delete')}>Remove</Button>
          </Can>
          <div className="flex-1" />
          <Can permission="recruitment.candidates.advance">
            <Button variant="ghost" icon={XCircle} onClick={() => setModal('reject')}>Reject</Button>
            {c.stage === 'offer' && c.offer_status === 'accepted' && can('hr.employees.create') ? (
              <Button variant="primary" icon={UserPlus} onClick={() => setModal('hire')}>Hire</Button>
            ) : next && (
              <Button variant="primary" iconRight={ArrowRight} onClick={() => (next === 'interview' ? setModal('interview') : next === 'offer' ? setModal('offer') : move(next))}>
                {next === 'interview' ? 'Schedule interview' : next === 'offer' ? 'Make an offer' : 'Move to screening'}
              </Button>
            )}
          </Can>
        </>
      )}
    >
      {error && <Alert tone="critical">{error}</Alert>}
      {c && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <Avatar name={candidateName(c)} size="lg" />
            <div className="flex flex-wrap gap-2">
              {c.email && <a href={`mailto:${c.email}`}><Button size="sm" variant="secondary" icon={Mail}>Email</Button></a>}
              {c.phone && <a href={`tel:${c.phone}`}><Button size="sm" variant="secondary" icon={Phone}>Call</Button></a>}
              {c.resume_url && <a href={c.resume_url} target="_blank" rel="noreferrer noopener"><Button size="sm" variant="secondary" icon={FileText}>Résumé</Button></a>}
              <SourceTaskButton app="recruitment" type="candidate" recordId={c.id} title={`Follow up: ${candidateName(c)}`} />
            </div>
          </div>

          {c.stage === 'hired' && (
            <Alert tone="positive" icon={BadgeCheck}>
              Hired and added to HR.{' '}
              {c.employee_id && <Link className="font-medium underline" href={`/hr/employees?open=${c.employee_id}`}>Open the employee record</Link>}
            </Alert>
          )}
          {c.stage === 'rejected' && (
            <Alert tone="info" action={can('recruitment.candidates.advance') && <Button size="sm" onClick={() => move('screening')}>Reconsider</Button>}>
              Rejected{c.rejected_reason ? `: ${c.rejected_reason}` : '.'}
            </Alert>
          )}

          <DetailGrid
            items={[
              { label: 'Email', value: c.email },
              { label: 'Phone', value: c.phone },
              { label: 'Current company', value: c.current_company },
              { label: 'Experience', value: c.experience_years !== null && c.experience_years !== undefined ? `${Number(c.experience_years)} years` : null },
              { label: 'Rating', value: c.rating ? <Stars value={c.rating} /> : null },
              { label: 'Owner', value: nameOf(c.owner_id) },
              { label: 'Cover note', value: c.cover_note, full: true },
            ]}
          />

          {(c.offer_status || c.stage === 'offer') && (
            <section className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-4">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-medium">Offer</h3>
                {c.offer_status && <Badge size="sm" tone={OFFER_TONE[c.offer_status]}>{titleCase(c.offer_status)}</Badge>}
                <div className="flex-1" />
                <Can permission="recruitment.offers.view">
                  {!closed && <Button size="sm" variant="secondary" onClick={() => setModal('offer')}>{c.offer_status ? 'Update offer' : 'Make an offer'}</Button>}
                </Can>
              </div>
              {c.offer_ctc_paise !== null && c.offer_ctc_paise !== undefined ? (
                <p className="text-sm text-[var(--text-secondary)]">
                  {money(Number(c.offer_ctc_paise) / 100)} a year{c.offer_joining_on ? ` · joining ${date(c.offer_joining_on)}` : ''}
                </p>
              ) : (
                <p className="text-sm text-[var(--text-tertiary)]">{can('recruitment.offers.view') ? 'No terms yet.' : 'Offer terms are visible to people who handle offers.'}</p>
              )}
            </section>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-[var(--text-secondary)]">Interviews</h3>
              {!closed && (
                <Can permission="recruitment.candidates.edit">
                  <Button size="sm" variant="ghost" icon={CalendarPlus} onClick={() => setModal('interview')}>Schedule</Button>
                </Can>
              )}
            </div>
            {c.interviews.length === 0 ? (
              <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-3 py-5 text-center text-sm text-[var(--text-tertiary)]">No interviews yet.</p>
            ) : (
              <ul className="space-y-2">
                {c.interviews.map((i) => (
                  <li key={i.id} className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{date(i.scheduled_at, 'datetime')}</span>
                      <span className="text-[var(--text-tertiary)]">{titleCase(i.mode)} · {i.duration_minutes}m · {nameOf(i.interviewer_id)}</span>
                      <Badge size="sm" tone={i.status === 'completed' ? 'positive' : i.status === 'scheduled' ? 'info' : 'neutral'}>{titleCase(i.status)}</Badge>
                      <div className="flex-1" />
                      {i.status === 'scheduled' && <Button size="xs" variant="secondary" onClick={() => setModal({ feedback: i })}>Add feedback</Button>}
                    </div>
                    {i.feedback && (
                      <p className="mt-1.5 whitespace-pre-wrap text-sm text-[var(--text-secondary)]">
                        {i.rating ? <Stars value={i.rating} small /> : null} {i.recommendation && <strong>{RECOMMENDATION[i.recommendation]}. </strong>}{i.feedback}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Notes and history</h3>
            <Can permission="recruitment.candidates.edit">
              <form onSubmit={addNote} className="mb-3 flex gap-2">
                <div className="min-w-0 flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the hiring team…" /></div>
                <Button type="submit" icon={Send} disabled={!note.trim()}>Add</Button>
              </form>
            </Can>
            <ul className="space-y-2.5">
              {c.notes.map((n) => (
                <li key={n.id} className="flex gap-2.5">
                  {n.kind === 'event'
                    ? <History className="mt-1 size-3.5 shrink-0 text-[var(--text-tertiary)]" />
                    : <Avatar name={nameOf(n.author_id)} size="xs" className="mt-0.5" />}
                  <div className="min-w-0">
                    <p className={cn('whitespace-pre-wrap', n.kind === 'event' ? 'text-sm text-[var(--text-secondary)]' : 'text-base')}>
                      {n.body.replace(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/, (iso) => date(iso, 'datetime'))}
                    </p>
                    <p className="text-xs text-[var(--text-tertiary)]">{n.author_id ? nameOf(n.author_id) : 'Careers page'} · {relativeTime(n.created_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {c && modal === 'interview' && <InterviewModal candidate={c} people={people} onClose={() => setModal(null)} onSaved={refresh} />}
      {c && modal === 'offer' && <OfferModal candidate={c} onClose={() => setModal(null)} onSaved={refresh} />}
      {c && modal === 'hire' && <HireModal candidate={c} onClose={() => setModal(null)} onSaved={refresh} />}
      {c && modal === 'reject' && <RejectModal onClose={() => setModal(null)} onReject={(reason) => move('rejected', reason)} />}
      {c && modal?.feedback && <FeedbackModal interview={modal.feedback} onClose={() => setModal(null)} onSaved={refresh} />}
      <ConfirmModal
        open={modal === 'delete'}
        onClose={() => setModal(null)}
        onConfirm={remove}
        danger
        title="Remove this candidate?"
        description="Their application, interviews and notes are deleted. Rejecting keeps the record instead."
        confirmLabel="Remove"
      />
    </Drawer>
  );
}

function Stars({ value, small }) {
  return (
    <span className="inline-flex items-center gap-0.5 align-middle" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn(small ? 'size-3' : 'size-3.5', n <= value ? 'fill-[#f59e0b] text-[#f59e0b]' : 'text-[var(--text-disabled)]')} />
      ))}
    </span>
  );
}

/* ── modals ───────────────────────────────────────────────────────────────── */

function useSubmit(onDone) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn, success) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (success) toast.success(success);
      await onDone?.(result);
      return result;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const tomorrowAtTen = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(10, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
};

export function InterviewModal({ candidate, people, onClose, onSaved }) {
  const { user } = useWorkspace();
  const [form, setForm] = useState({ scheduled_at: tomorrowAtTen(), duration_minutes: '45', mode: 'video', interviewer_id: user?.id ?? '', location: '' });
  const { busy, error, run } = useSubmit(async () => { await onSaved(); onClose(); });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = () => run(() => api.post(`/recruitment/candidates/${candidate.id}/interviews`, {
    scheduled_at: new Date(form.scheduled_at).toISOString(),
    duration_minutes: Number(form.duration_minutes),
    mode: form.mode,
    interviewer_id: form.interviewer_id,
    location: form.location || null,
  }), 'Interview scheduled');

  return (
    <Modal
      open
      onClose={onClose}
      title={`Interview ${candidateName(candidate)}`}
      description="The interviewer is notified. Scheduling moves the candidate to the interview stage."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={CalendarPlus} loading={busy} onClick={submit}>Schedule</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="When">{(p) => <Input {...p} type="datetime-local" value={form.scheduled_at} onChange={set('scheduled_at')} />}</Field>
          <Field label="Length">
            {(p) => <Select {...p} value={form.duration_minutes} onChange={set('duration_minutes')}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select>}
          </Field>
          <Field label="Interviewer">
            {(p) => <Select {...p} value={form.interviewer_id} onChange={set('interviewer_id')}>{people.map((x) => <option key={x.user_id} value={x.user_id}>{x.name}</option>)}</Select>}
          </Field>
          <Field label="Mode">
            {(p) => <Select {...p} value={form.mode} onChange={set('mode')}><option value="video">Video</option><option value="phone">Phone</option><option value="in_person">In person</option></Select>}
          </Field>
        </div>
        <Field label={form.mode === 'in_person' ? 'Address' : 'Meeting link or number'}>
          {(p) => <Input {...p} value={form.location} onChange={set('location')} />}
        </Field>
      </div>
    </Modal>
  );
}

export function FeedbackModal({ interview, onClose, onSaved }) {
  const [form, setForm] = useState({ rating: interview.rating ?? 3, recommendation: interview.recommendation ?? 'yes', feedback: interview.feedback ?? '' });
  const { busy, error, run } = useSubmit(async () => { await onSaved(); onClose(); });
  const save = (status) => run(() => api.patch(`/recruitment/interviews/${interview.id}`, {
    status, rating: Number(form.rating), recommendation: form.recommendation, feedback: form.feedback || null,
  }), status === 'completed' ? 'Feedback recorded' : 'Interview updated');

  return (
    <Modal
      open
      onClose={onClose}
      title="Interview feedback"
      description="What you saw, so the next person does not have to guess."
      footer={
        <>
          <Button variant="ghost" onClick={() => save('no_show')} disabled={busy}>No-show</Button>
          <Button variant="ghost" onClick={() => save('cancelled')} disabled={busy}>Cancelled</Button>
          <Button variant="primary" loading={busy} onClick={() => save('completed')}>Complete</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rating">
            {(p) => <Select {...p} value={form.rating} onChange={(e) => setForm((f) => ({ ...f, rating: e.target.value }))}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} / 5</option>)}</Select>}
          </Field>
          <Field label="Recommendation">
            {(p) => <Select {...p} value={form.recommendation} onChange={(e) => setForm((f) => ({ ...f, recommendation: e.target.value }))}>{Object.entries(RECOMMENDATION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
          </Field>
        </div>
        <Field label="Feedback" required>
          {(p) => <Textarea {...p} rows={5} value={form.feedback} onChange={(e) => setForm((f) => ({ ...f, feedback: e.target.value }))} data-autofocus />}
        </Field>
      </div>
    </Modal>
  );
}

function OfferModal({ candidate, onClose, onSaved }) {
  const { can } = useWorkspace();
  const [ctc, setCtc] = useState(candidate.offer_ctc_paise ? String(Number(candidate.offer_ctc_paise) / 100) : '');
  const [joining, setJoining] = useState(candidate.offer_joining_on ?? '');
  const { busy, error, run } = useSubmit(async () => { await onSaved(); onClose(); });
  const changed = candidate.offer_status && (
    (ctc && Math.round(Number(ctc) * 100) !== Number(candidate.offer_ctc_paise)) || (joining && joining !== candidate.offer_joining_on));

  const save = (status) => run(() => api.put(`/recruitment/candidates/${candidate.id}/offer`, {
    status, ctc_annual: ctc ? Number(ctc) : undefined, joining_on: joining || undefined,
  }), `Offer ${status}`);

  const s = candidate.offer_status;
  return (
    <Modal
      open
      onClose={onClose}
      title="Offer"
      description="Propose terms, get them approved, then record the candidate’s answer. Changing the terms sends it back for approval."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {(!s || changed || s === 'declined') && <Button variant={can('recruitment.offers.approve') ? 'secondary' : 'primary'} loading={busy} onClick={() => save('proposed')}>Propose</Button>}
          {can('recruitment.offers.approve') && (!s || s === 'proposed' || changed) && <Button variant="primary" loading={busy} onClick={() => save('approved')}>Approve</Button>}
          {['approved', 'accepted'].includes(s) && !changed && (
            <>
              <Button variant="ghost" loading={busy} onClick={() => save('declined')}>Declined</Button>
              {s === 'approved' && <Button variant="primary" loading={busy} onClick={() => save('accepted')}>Accepted</Button>}
            </>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Annual CTC" hint="In rupees">{(p) => <Input {...p} type="number" min="1" value={ctc} onChange={(e) => setCtc(e.target.value)} data-autofocus />}</Field>
          <Field label="Joining date">{(p) => <Input {...p} type="date" value={joining ?? ''} onChange={(e) => setJoining(e.target.value)} />}</Field>
        </div>
        {s && <p className="text-sm text-[var(--text-secondary)]">Current status: <Badge size="sm" tone={OFFER_TONE[s]}>{titleCase(s)}</Badge></p>}
      </div>
    </Modal>
  );
}

function HireModal({ candidate, onClose, onSaved }) {
  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState({
    joined_on: candidate.offer_joining_on ?? new Date().toISOString().slice(0, 10),
    designation: candidate.job_title ?? '', department_id: candidate.job_department_id ?? '', status: 'on_probation',
    employment_type: candidate.job_employment_type ?? 'full_time',
  });
  const { busy, error, run } = useSubmit(async () => { await onSaved(); onClose(); });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  useEffect(() => {
    api.get('/hr/departments').then((r) => setDepartments(r.data ?? [])).catch(() => {});
  }, []);

  const submit = () => run(() => api.post(`/recruitment/candidates/${candidate.id}/hire`, {
    ...form, department_id: form.department_id || null, designation: form.designation || null,
  }), `${candidateName(candidate)} is hired`);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Hire ${candidateName(candidate)}`}
      description="Creates their employee record in HR, with leave balances, and closes the opening once every seat is filled."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={UserPlus} loading={busy} onClick={submit}>Hire and add to HR</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Joining date">{(p) => <Input {...p} type="date" value={form.joined_on} onChange={set('joined_on')} />}</Field>
          <Field label="Designation">{(p) => <Input {...p} value={form.designation} onChange={set('designation')} />}</Field>
          <Field label="Department">
            {(p) => <Select {...p} value={form.department_id} onChange={set('department_id')}><option value="">None</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
          </Field>
          <Field label="Starts as">
            {(p) => <Select {...p} value={form.status} onChange={set('status')}><option value="on_probation">On probation</option><option value="active">Active</option></Select>}
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function RejectModal({ onClose, onReject }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="Reject candidate"
      description="The reason stays on their record, so the next recruiter knows why."
      size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!reason.trim()} onClick={() => onReject(reason)}>Reject</Button></>}
    >
      <Field label="Reason" required>
        {(p) => <Textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Needs B2 German; currently A2." data-autofocus />}
      </Field>
    </Modal>
  );
}
