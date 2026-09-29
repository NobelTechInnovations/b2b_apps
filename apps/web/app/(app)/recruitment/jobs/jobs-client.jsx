'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Briefcase, MapPin, Globe, Copy, Pencil, Trash2, Lock } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { Can, useWorkspace } from '@/lib/workspace';
import { usePeople, titleCase } from '@/lib/people';
import { useOrganization } from '@/lib/use-organization';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Modal, ConfirmModal } from '@/components/ui/modal';
import { Badge, Card, EmptyState, PageHeader, Alert, Skeleton } from '@/components/ui/primitives';

const STATUS_TONE = { open: 'positive', draft: 'neutral', on_hold: 'caution', closed: 'neutral' };
const EMPLOYMENT = ['full_time', 'part_time', 'contract', 'intern', 'consultant'];

export default function JobsClient() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { can } = useWorkspace();
  const organization = useOrganization();
  const { people } = usePeople('/recruitment/people');
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // {} for new
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    try {
      setJobs((await api.get('/recruitment/jobs')).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load openings.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (params.get('new') === '1') setEditing({}); }, [params]);

  // Known only in the browser; reading it during render would not match the server HTML.
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const careers = organization?.slug && origin ? `${origin}/careers/${organization.slug}` : null;

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Copy failed', { description: url });
    }
  }

  async function remove() {
    try {
      await api.del(`/recruitment/jobs/${deleting.id}`);
      toast.success('Opening deleted');
      setDeleting(null);
      load();
    } catch (err) {
      toast.error('Could not delete', { description: err instanceof ApiError ? err.message : undefined });
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Openings"
        description="Open and public roles appear on your careers page, where anyone can apply."
        actions={
          <div className="flex gap-2">
            {careers && <Button variant="secondary" icon={Copy} onClick={() => copyLink(careers)}>Copy careers link</Button>}
            <Can permission="recruitment.jobs.manage">
              <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New opening</Button>
            </Can>
          </div>
        }
      />
      {error && <Alert tone="critical">{error}</Alert>}

      {!jobs ? (
        <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-36" /><Skeleton className="h-36" /></div>
      ) : jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={Briefcase}
            title="No openings yet"
            description="Describe the role once; the careers page, the pipeline and the hiring notifications follow from it."
            action={can('recruitment.jobs.manage') && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New opening</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {jobs.map((job) => (
            <Card key={job.id} className="flex flex-col p-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/recruitment?job=${job.id}`} className="block truncate text-md font-semibold hover:underline">{job.title}</Link>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-tertiary)]">
                    {job.department_name && <span>{job.department_name}</span>}
                    {job.location && <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{job.location}</span>}
                    <span>{titleCase(job.employment_type)}</span>
                  </p>
                </div>
                <Badge size="sm" tone={STATUS_TONE[job.status]}>{titleCase(job.status)}</Badge>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <Count label="In pipeline" value={job.active_count} />
                <Count label="New this week" value={job.new_count} />
                <Count label="Hired" value={`${job.hired_count}/${job.openings}`} />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-tertiary)]">
                {job.status === 'open' && job.is_public
                  ? <span className="inline-flex items-center gap-1"><Globe className="size-3" /> On careers page</span>
                  : <span className="inline-flex items-center gap-1"><Lock className="size-3" /> Not public</span>}
                {job.closes_on && <span>· closes {date(job.closes_on)}</span>}
                <div className="flex-1" />
                {job.status === 'open' && job.is_public && careers && (
                  <Button size="xs" variant="ghost" icon={Copy} onClick={() => copyLink(`${careers}/jobs/${job.id}`)}>Link</Button>
                )}
                <Can permission="recruitment.jobs.manage">
                  <Button size="xs" variant="ghost" icon={Pencil} onClick={() => setEditing(job)}>Edit</Button>
                  <Button size="xs" variant="ghost" icon={Trash2} onClick={() => setDeleting(job)} aria-label="Delete" />
                </Can>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <JobModal
          job={editing}
          people={people}
          onClose={() => { setEditing(null); if (params.get('new')) router.replace('/recruitment/jobs'); }}
          onSaved={load}
        />
      )}
      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        danger
        title={`Delete “${deleting?.title}”?`}
        description="Its candidates are deleted with it. To stop hiring but keep the history, close the opening instead."
        confirmLabel="Delete"
      />
    </div>
  );
}

function Count({ label, value }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-2 py-2">
      <p className="metric text-lg font-semibold">{value}</p>
      <p className="text-2xs text-[var(--text-tertiary)]">{label}</p>
    </div>
  );
}

function JobModal({ job, people, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !job.id;
  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState({
    title: job.title ?? '', department_id: job.department_id ?? '', location: job.location ?? '',
    employment_type: job.employment_type ?? 'full_time', openings: String(job.openings ?? 1), status: job.status ?? 'open',
    is_public: job.is_public ?? true, description: job.description ?? '', salary_range: job.salary_range ?? '',
    closes_on: job.closes_on ?? '', hiring_manager_id: job.hiring_manager_id ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  useEffect(() => {
    api.get('/hr/departments').then((r) => setDepartments(r.data ?? [])).catch(() => {});
  }, []);

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    const nullIfBlank = (v) => (v === '' ? null : v);
    const payload = {
      title: form.title, department_id: nullIfBlank(form.department_id), location: nullIfBlank(form.location),
      employment_type: form.employment_type, openings: Number(form.openings) || 1, status: form.status, is_public: form.is_public,
      description: form.description, salary_range: nullIfBlank(form.salary_range), closes_on: nullIfBlank(form.closes_on),
      hiring_manager_id: nullIfBlank(form.hiring_manager_id),
    };
    try {
      if (isNew) await api.post('/recruitment/jobs', payload);
      else await api.patch(`/recruitment/jobs/${job.id}`, payload);
      toast.success(isNew ? 'Opening created' : 'Opening saved');
      onClose();
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'New opening' : 'Edit opening'}
      size="xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>{isNew ? 'Create opening' : 'Save'}</Button></>}
    >
      <form onSubmit={submit} className="space-y-4">
        {formError && <Alert tone="critical">{formError}</Alert>}
        <Field label="Job title" required error={errors.title}>{(p) => <Input {...p} value={form.title} onChange={set('title')} placeholder="e.g. Visa Counsellor" data-autofocus />}</Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Department">
            {(p) => <Select {...p} value={form.department_id} onChange={set('department_id')}><option value="">None</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
          </Field>
          <Field label="Location">{(p) => <Input {...p} value={form.location} onChange={set('location')} placeholder="Delhi · Remote" />}</Field>
          <Field label="Type">
            {(p) => <Select {...p} value={form.employment_type} onChange={set('employment_type')}>{EMPLOYMENT.map((e) => <option key={e} value={e}>{titleCase(e)}</option>)}</Select>}
          </Field>
          <Field label="Openings">{(p) => <Input {...p} type="number" min="1" value={form.openings} onChange={set('openings')} />}</Field>
          <Field label="Salary range" hint="Shown publicly">{(p) => <Input {...p} value={form.salary_range} onChange={set('salary_range')} placeholder="₹3–4.5 LPA" />}</Field>
          <Field label="Applications close">{(p) => <Input {...p} type="date" value={form.closes_on} onChange={set('closes_on')} />}</Field>
          <Field label="Status">
            {(p) => <Select {...p} value={form.status} onChange={set('status')}>{['open', 'draft', 'on_hold', 'closed'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>}
          </Field>
          <Field label="Hiring manager" error={errors.hiring_manager_id}>
            {(p) => <Select {...p} value={form.hiring_manager_id} onChange={set('hiring_manager_id')}><option value="">None</option>{people.map((x) => <option key={x.user_id} value={x.user_id}>{x.name}</option>)}</Select>}
          </Field>
        </div>
        <Field label="Description" hint="What the role is, who thrives in it, what you offer. Markdown works.">
          {(p) => <Textarea {...p} rows={7} value={form.description} onChange={set('description')} />}
        </Field>
        <Checkbox label="List on the careers page" description="Only open roles are listed, whatever this says." checked={form.is_public} onChange={set('is_public')} />
      </form>
    </Modal>
  );
}
