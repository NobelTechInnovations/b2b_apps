'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, ArrowRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, PasswordInput, Field, Checkbox } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [loading, setLoading] = useState(false);

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
      const response = await api.post('/auth/login', form);

      if (response.data.needs_onboarding) {
        router.push('/onboarding');
        return;
      }
      router.push(next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/dashboard');
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = error.fieldErrors;
        if (Object.keys(fields).length) setErrors(fields);
        else setFormError(error.message);
      } else {
        setFormError('We could not reach the server. Check your connection and try again.');
      }
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">Welcome back</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        Sign in to your workspace.
      </p>

      {formError && (
        <Alert tone="critical" className="mt-5">
          {formError}
        </Alert>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
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
              autoFocus
            />
          )}
        </Field>

        <Field label="Password" error={errors.password}>
          {(props) => (
            <PasswordInput
              {...props}
              name="password"
              autoComplete="current-password"
              placeholder="••••••••••"
              value={form.password}
              onChange={set('password')}
              error={errors.password}
              required
            />
          )}
        </Field>

        <div className="flex items-center justify-between pt-1">
          <Checkbox label="Keep me signed in" defaultChecked />
          <Link
            href="/forgot-password"
            className="rounded text-sm font-medium text-[var(--text-brand)] hover:underline"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full" iconRight={ArrowRight}>
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-base text-[var(--text-secondary)]">
        New here?{' '}
        <Link href="/signup" className="font-medium text-[var(--text-brand)] hover:underline">
          Create a workspace
        </Link>
      </p>
    </div>
  );
}
