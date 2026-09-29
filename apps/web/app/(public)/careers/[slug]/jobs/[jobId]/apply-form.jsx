'use client';

import { useState } from 'react';
import { CheckCircle2, Send } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';

/**
 * Posted from the browser, not the server, so the throttle counts the
 * applicant's own connection rather than the web server's.
 */
export function ApplyForm({ slug, jobId }) {
  const [form, setForm] = useState({});
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setError(null);
    const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''));
    if (payload.experience_years) payload.experience_years = Number(payload.experience_years);
    if (trap) payload.website = trap;
    try {
      await api.post(`/careers/${slug}/jobs/${jobId}/apply`, payload, { retry: false, redirectOnUnauthorized: false });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : 'Could not send your application. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="py-6 text-center">
        <CheckCircle2 className="mx-auto size-9 text-[var(--color-positive-600)]" />
        <p className="mt-3 font-medium">Application received</p>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">Thank you. The team reads every application and will be in touch.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert tone="critical">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <Field label="First name" required error={errors.first_name}>{(p) => <Input {...p} autoComplete="given-name" value={form.first_name ?? ''} onChange={set('first_name')} />}</Field>
        <Field label="Last name" error={errors.last_name}>{(p) => <Input {...p} autoComplete="family-name" value={form.last_name ?? ''} onChange={set('last_name')} />}</Field>
      </div>
      <Field label="Email" required error={errors.email}>{(p) => <Input {...p} type="email" autoComplete="email" value={form.email ?? ''} onChange={set('email')} />}</Field>
      <Field label="Phone" required error={errors.phone}>{(p) => <Input {...p} type="tel" autoComplete="tel" value={form.phone ?? ''} onChange={set('phone')} />}</Field>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <Field label="Current company" error={errors.current_company}>{(p) => <Input {...p} value={form.current_company ?? ''} onChange={set('current_company')} />}</Field>
        <Field label="Experience (years)" error={errors.experience_years}>{(p) => <Input {...p} type="number" min="0" step="0.5" value={form.experience_years ?? ''} onChange={set('experience_years')} />}</Field>
      </div>
      <Field label="Link to your CV" hint="Google Drive, Dropbox or LinkedIn" error={errors.resume_url}>
        {(p) => <Input {...p} type="url" placeholder="https://" value={form.resume_url ?? ''} onChange={set('resume_url')} />}
      </Field>
      <Field label="Why this role?" error={errors.cover_note}>{(p) => <Textarea {...p} rows={4} value={form.cover_note ?? ''} onChange={set('cover_note')} />}</Field>
      <div aria-hidden="true" className="absolute left-[-10000px] h-px w-px overflow-hidden">
        <label>Website <input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} /></label>
      </div>
      <Button type="submit" variant="primary" icon={Send} loading={busy} className="w-full">Send application</Button>
    </form>
  );
}
