'use client';

import { useState } from 'react';
import { CheckCircle2, Send } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, Textarea, Checkbox } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';

const INPUT_TYPE = { email: 'email', phone: 'tel', number: 'number', date: 'date' };

/**
 * A form as the public sees it. The same component renders the live page
 * at /f/<token> and the preview in the builder, so what you design is
 * exactly what people fill in. Validation messages come from the server,
 * which checks every answer against the form's own field list.
 */
export function PublicForm({ form, token, preview = false }) {
  const [answers, setAnswers] = useState({});
  const [trap, setTrap] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const set = (key, value) => setAnswers((a) => ({ ...a, [key]: value }));
  const toggle = (key, option) => setAnswers((a) => {
    const list = new Set(a[key] ?? []);
    if (list.has(option)) list.delete(option); else list.add(option);
    return { ...a, [key]: [...list] };
  });

  async function submit(event) {
    event.preventDefault();
    if (preview) return;
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      const response = await api.post(`/public-forms/${token}/submit`, { answers, website: trap || undefined }, { retry: false, redirectOnUnauthorized: false });
      setDone(response.data.message ?? 'Thank you — we have received your response.');
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(err instanceof ApiError ? err.message : 'Could not send. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="py-10 text-center">
        <CheckCircle2 className="mx-auto size-10 text-[var(--color-positive-600)]" />
        <p className="mt-4 text-lg font-medium">{done}</p>
      </div>
    );
  }

  if (form.open === false) {
    return <Alert tone="info">This form is no longer accepting responses.</Alert>;
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {formError && <Alert tone="critical">{formError}</Alert>}
      {form.fields.map((f) => (
        <FieldInput key={f.key} field={f} value={answers[f.key]} error={errors[f.key]} onChange={(v) => set(f.key, v)} onToggle={(o) => toggle(f.key, o)} />
      ))}
      {/* Hidden from people, irresistible to bots. */}
      <div aria-hidden="true" className="absolute left-[-10000px] h-px w-px overflow-hidden">
        <label>Website <input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} /></label>
      </div>
      <Button type="submit" variant="primary" size="lg" icon={Send} loading={busy} disabled={preview} className="w-full sm:w-auto">
        {preview ? 'Submit (preview)' : 'Submit'}
      </Button>
    </form>
  );
}

function FieldInput({ field: f, value, error, onChange, onToggle }) {
  if (f.type === 'checkbox') {
    return (
      <div>
        <Checkbox label={`${f.label}${f.required ? ' *' : ''}`} description={f.help} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {error && <p className="mt-1 text-xs text-[var(--color-critical-600)]">{error}</p>}
      </div>
    );
  }
  if (f.type === 'multi_select') {
    return (
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{f.label}{f.required && <span className="text-[var(--color-critical-600)]"> *</span>}</legend>
        {f.help && <p className="mb-2 text-xs text-[var(--text-tertiary)]">{f.help}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {f.options.map((o) => <Checkbox key={o} label={o} checked={(value ?? []).includes(o)} onChange={() => onToggle(o)} />)}
        </div>
        {error && <p className="mt-1 text-xs text-[var(--color-critical-600)]">{error}</p>}
      </fieldset>
    );
  }
  return (
    <Field label={f.label} required={f.required} hint={f.help || undefined} error={error}>
      {(p) => (f.type === 'long_text' ? (
        <Textarea {...p} rows={4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      ) : f.type === 'select' ? (
        <Select {...p} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : (
        <Input
          {...p}
          type={INPUT_TYPE[f.type] ?? 'text'}
          autoComplete={f.maps_to === 'email' ? 'email' : f.maps_to === 'phone' ? 'tel' : f.maps_to === 'full_name' ? 'name' : undefined}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      ))}
    </Field>
  );
}
