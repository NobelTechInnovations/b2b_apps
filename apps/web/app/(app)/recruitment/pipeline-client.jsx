'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Briefcase, CalendarClock, Globe, Search, Eye, EyeOff } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { date, relativeTime } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { usePeople, titleCase } from '@/lib/people';
import { useOrganization } from '@/lib/use-organization';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Avatar, Badge, Card, EmptyState, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';
import { CandidateDrawer, InterviewModal, candidateName } from '@/components/recruitment/candidate-drawer';

const BOARD = ['applied', 'screening', 'interview', 'offer', 'hired'];
const ACCENT = {
  applied: 'bg-[#0ea5e9]', screening: 'bg-[var(--color-brand-500)]', interview: 'bg-[#f59e0b]',
  offer: 'bg-[#8b5cf6]', hired: 'bg-[#10b981]', rejected: 'bg-[var(--color-ink-400)]',
};
const SOURCES = ['manual', 'referral', 'linkedin', 'naukri', 'walk_in', 'agency', 'careers_page', 'other'];

export default function PipelineClient() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { can } = useWorkspace();
  const organization = useOrganization();
  const { people, nameOf } = usePeople('/recruitment/people');

  const [jobs, setJobs] = useState([]);
  const [jobId, setJobId] = useState('');
  const [search, setSearch] = useState('');
  const [showRejected, setShowRejected] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [scheduling, setScheduling] = useState(null);

  useEffect(() => {
    if (params.get('candidate')) setOpenId(params.get('candidate'));
    if (params.get('job')) setJobId(params.get('job'));
    if (params.get('new') === '1') setAdding(true);
  }, [params]);

  useEffect(() => {
    api.get('/recruitment/jobs').then((r) => setJobs(r.data)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/recruitment/candidates', { query: { job_id: jobId || undefined, q: search || undefined, limit: 100 } });
      setCandidates(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load candidates.');
    }
  }, [jobId, search]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  async function drop(stage) {
    const c = dragging;
    setDragging(null);
    setOver(null);
    if (!c || c.stage === stage) return;
    // Hiring and interviews carry details a drag cannot supply.
    if (stage === 'hired' || stage === 'offer' || c.stage === 'hired') { setOpenId(c.id); return; }
    if (stage === 'interview') { setScheduling(c); return; }
    const before = candidates;
    setCandidates((list) => list.map((x) => (x.id === c.id ? { ...x, stage } : x)));
    try {
      await api.post(`/recruitment/candidates/${c.id}/stage`, { stage });
    } catch (err) {
      setCandidates(before);
      toast.error('Could not move the candidate', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const columns = showRejected ? [...BOARD, 'rejected'] : BOARD;
  const openJobs = jobs.filter((j) => j.status === 'open');
  const careersUrl = organization?.slug ? `/careers/${organization.slug}` : null;
  const canMove = can('recruitment.candidates.advance');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hiring pipeline"
        description="Drag candidates between stages. Scheduling an interview or making an offer moves them for you."
        actions={
          <div className="flex gap-2">
            {careersUrl && (
              <a href={careersUrl} target="_blank" rel="noreferrer"><Button variant="secondary" icon={Globe}>Careers page</Button></a>
            )}
            <Can permission="recruitment.candidates.edit">
              <Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={openJobs.length === 0 && jobs.length === 0}>Add candidate</Button>
            </Can>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input icon={Search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email or phone…" className="w-full max-w-xs" />
        <Select value={jobId} onChange={(e) => setJobId(e.target.value)} className="w-auto min-w-[14rem]" aria-label="Opening">
          <option value="">All openings</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.status !== 'open' ? ` (${titleCase(j.status)})` : ''}</option>)}
        </Select>
        <Button variant="ghost" size="sm" icon={showRejected ? EyeOff : Eye} onClick={() => setShowRejected((v) => !v)}>
          {showRejected ? 'Hide rejected' : 'Show rejected'}
        </Button>
      </div>

      {error && <Alert tone="critical">{error}</Alert>}

      {jobs.length === 0 && candidates?.length === 0 ? (
        <Card>
          <EmptyState
            icon={Briefcase}
            title="Open your first position"
            description="Create an opening, share your careers page, and applicants land here automatically."
            action={can('recruitment.jobs.manage') && <Link href="/recruitment/jobs?new=1"><Button variant="primary" icon={Plus}>New opening</Button></Link>}
          />
        </Card>
      ) : !candidates ? (
        <div className="flex gap-3 overflow-hidden">
          {BOARD.map((s) => <div key={s} className="w-64 shrink-0 space-y-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-20 w-full" /></div>)}
        </div>
      ) : (
        <div className="-mx-6 overflow-x-auto px-6 pb-4 lg:-mx-8 lg:px-8">
          <div className="flex gap-3" style={{ minWidth: 'min-content' }}>
            {columns.map((stage) => {
              const cards = candidates.filter((c) => c.stage === stage);
              return (
                <section
                  key={stage}
                  onDragOver={(e) => { if (dragging && canMove) { e.preventDefault(); setOver(stage); } }}
                  onDragLeave={() => setOver((s) => (s === stage ? null : s))}
                  onDrop={(e) => { e.preventDefault(); drop(stage); }}
                  className={cn(
                    'flex w-64 shrink-0 flex-col rounded-[var(--radius-xl)] bg-[var(--surface-sunken)] p-2 transition-colors',
                    over === stage && 'ring-2 ring-[var(--color-brand-400)]',
                  )}
                >
                  <header className="mb-2 flex items-center gap-2 px-1.5 pt-1">
                    <span className={cn('size-2 rounded-full', ACCENT[stage])} />
                    <h2 className="text-sm font-semibold">{titleCase(stage)}</h2>
                    <span className="tabular text-xs text-[var(--text-tertiary)]">{cards.length}</span>
                  </header>
                  <div className="flex min-h-24 flex-col gap-2">
                    {cards.map((c) => (
                      <article
                        key={c.id}
                        draggable={canMove && stage !== 'hired'}
                        onDragStart={() => setDragging(c)}
                        onDragEnd={() => { setDragging(null); setOver(null); }}
                        onClick={() => setOpenId(c.id)}
                        className={cn(
                          'cursor-pointer rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3 shadow-xs transition hover:border-[var(--border-default)]',
                          dragging?.id === c.id && 'opacity-50',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Avatar name={candidateName(c)} size="sm" />
                          <p className="min-w-0 flex-1 truncate text-sm font-medium">{candidateName(c)}</p>
                        </div>
                        {!jobId && <p className="mt-1.5 truncate text-xs text-[var(--text-secondary)]">{c.job_title}</p>}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-[var(--text-tertiary)]">
                          {c.source === 'careers_page' && <Badge size="sm" tone="info">Applied online</Badge>}
                          {c.offer_status && <Badge size="sm" tone={c.offer_status === 'accepted' ? 'positive' : 'caution'}>Offer {c.offer_status}</Badge>}
                          {c.next_interview_at && (
                            <span className="inline-flex items-center gap-1"><CalendarClock className="size-3" />{date(c.next_interview_at, 'datetime')}</span>
                          )}
                          {!c.next_interview_at && !c.offer_status && <span>{relativeTime(c.stage_changed_at ?? c.created_at)}</span>}
                        </div>
                      </article>
                    ))}
                    {cards.length === 0 && (
                      <p className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] px-2 py-6 text-center text-xs text-[var(--text-tertiary)]">
                        {stage === 'applied' ? 'New applicants land here' : 'Drop a candidate here'}
                      </p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {adding && (
        <AddCandidateModal
          jobs={jobs.filter((j) => j.status !== 'closed')}
          defaultJob={jobId}
          onClose={() => { setAdding(false); if (params.get('new')) router.replace('/recruitment'); }}
          onCreated={(c) => { load(); setOpenId(c.id); }}
        />
      )}
      {scheduling && (
        <InterviewModal candidate={scheduling} people={people} onClose={() => setScheduling(null)} onSaved={load} />
      )}
      {openId && (
        <CandidateDrawer
          candidateId={openId}
          people={people}
          nameOf={nameOf}
          onClose={() => { setOpenId(null); if (params.get('candidate')) router.replace('/recruitment'); }}
          onChanged={load}
        />
      )}
    </div>
  );
}

function AddCandidateModal({ jobs, defaultJob, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ job_id: defaultJob || jobs[0]?.id || '', source: 'manual' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      const payload = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
      if (payload.experience_years) payload.experience_years = Number(payload.experience_years);
      if (payload.rating) payload.rating = Number(payload.rating);
      const response = await api.post('/recruitment/candidates', payload);
      toast.success(`${candidateName(response.data)} added`);
      onClose();
      onCreated(response.data);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(err instanceof ApiError ? err.message : 'Could not add the candidate.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add candidate"
      description="For referrals, walk-ins and CVs from job portals. Online applicants are added for you."
      size="xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Plus} loading={busy} onClick={submit}>Add</Button></>}
    >
      <form onSubmit={submit} className="space-y-4">
        {formError && <Alert tone="critical">{formError}</Alert>}
        <Field label="Opening" required error={errors.job_id}>
          {(p) => <Select {...p} value={form.job_id} onChange={set('job_id')}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</Select>}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={errors.first_name}>{(p) => <Input {...p} value={form.first_name ?? ''} onChange={set('first_name')} data-autofocus />}</Field>
          <Field label="Last name">{(p) => <Input {...p} value={form.last_name ?? ''} onChange={set('last_name')} />}</Field>
          <Field label="Email" error={errors.email}>{(p) => <Input {...p} type="email" value={form.email ?? ''} onChange={set('email')} />}</Field>
          <Field label="Phone">{(p) => <Input {...p} value={form.phone ?? ''} onChange={set('phone')} />}</Field>
          <Field label="Current company">{(p) => <Input {...p} value={form.current_company ?? ''} onChange={set('current_company')} />}</Field>
          <Field label="Experience (years)">{(p) => <Input {...p} type="number" min="0" step="0.5" value={form.experience_years ?? ''} onChange={set('experience_years')} />}</Field>
          <Field label="Source">
            {(p) => <Select {...p} value={form.source} onChange={set('source')}>{SOURCES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>}
          </Field>
          <Field label="Résumé link" error={errors.resume_url} hint="Drive, Dropbox or portal link">{(p) => <Input {...p} type="url" value={form.resume_url ?? ''} onChange={set('resume_url')} />}</Field>
        </div>
        <Field label="Notes">{(p) => <Textarea {...p} rows={2} value={form.cover_note ?? ''} onChange={set('cover_note')} />}</Field>
      </form>
    </Modal>
  );
}
