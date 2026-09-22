'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, User, ArrowRight, Check } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, PasswordInput, Field } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

/** Mirrors the server-side policy so the feedback is honest, not decorative. */
function strength(password) {
  const checks = [
    { label: 'At least 10 characters', ok: password.length >= 10 },
    { label: 'A letter', ok: /[a-zA-Z]/.test(password) },
    { label: 'A number or symbol', ok: /[0-9\W]/.test(password) },
  ];
  return { checks, score: checks.filter((c) => c.ok).length };
}

export default function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const invitationToken = params.get('token');

  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [loading, setLoading] = useState(false);

  const { checks, score } = useMemo(() => strength(form.password), [form.password]);

  const set = (key) => (event) => {
    setForm((f) => ({ ...f, [key]: event.target.value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  async function onSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setFormError(null);
    setErrors({});

    try {
      const response = await api.post('/auth/register', {
        ...form,
        ...(invitationToken ? { invitation_token: invitationToken } : {}),
      });

      router.push(response.data.needs_onboarding ? '/onboarding' : '/dashboard');
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = error.fieldErrors;
        if (error.details?.field) fields[error.details.field] = error.message;
        if (Object.keys(fields).length) setErrors(fields);
        else setFormError(Array.isArray(error.details) ? error.details.join(' ') : error.message);
      } else {
        setFormError('We could not reach the server. Check your connection and try again.');
      }
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">
        {invitationToken ? 'Accept your invitation' : 'Create your workspace'}
      </h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        {invitationToken
          ? 'Set up your account to join the team.'
          : 'Free for 14 days. No card required.'}
      </p>

      {formError && <Alert tone="critical" className="mt-5">{formError}</Alert>}

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <Field label="Full name" error={errors.name}>
          {(props) => (
            <Input
              {...props}
              name="name"
              autoComplete="name"
              placeholder="Kartik Sharma"
              icon={User}
              value={form.name}
              onChange={set('name')}
              error={errors.name}
              required
              autoFocus
            />
          )}
        </Field>

        <Field label="Work email" error={errors.email}>
          {(props) => (
            <Input
              {...props}
              type="email"
              name="email"
              autoComplete="email"
              placeholder="you@company.com"
              icon={Mail}
              value={form.email}
              onChange={set('email')}
              error={errors.email}
              required
            />
          )}
        </Field>

        <Field label="Password" error={errors.password}>
          {(props) => (
            <PasswordInput
              {...props}
              name="password"
              autoComplete="new-password"
              placeholder="Choose a strong password"
              value={form.password}
              onChange={set('password')}
              error={errors.password}
              required
            />
          )}
        </Field>

        {form.password && (
          <div className="animate-fade space-y-2">
            <div className="flex gap-1" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-colors duration-300',
                    score > i
                      ? score === 3
                        ? 'bg-[var(--color-positive-500)]'
                        : 'bg-[var(--color-caution-500)]'
                      : 'bg-[var(--surface-active)]',
                  )}
                />
              ))}
            </div>
            <ul className="space-y-1">
              {checks.map((check) => (
                <li
                  key={check.label}
                  className={cn(
                    'flex items-center gap-1.5 text-xs transition-colors',
                    check.ok ? 'text-[var(--color-positive-600)]' : 'text-[var(--text-tertiary)]',
                  )}
                >
                  <Check className={cn('size-3', !check.ok && 'opacity-30')} strokeWidth={3} />
                  {check.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full" iconRight={ArrowRight}>
          {invitationToken ? 'Join the workspace' : 'Create workspace'}
        </Button>

        <p className="text-center text-xs leading-relaxed text-[var(--text-tertiary)]">
          By continuing you agree to our{' '}
          <Link href="/terms" className="underline underline-offset-2 hover:text-[var(--text-secondary)]">Terms</Link>
          {' '}and{' '}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-[var(--text-secondary)]">Privacy Policy</Link>.
        </p>
      </form>

      <p className="mt-6 text-center text-base text-[var(--text-secondary)]">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-[var(--text-brand)] hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
