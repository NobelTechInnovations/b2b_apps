'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PasswordInput, Field } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';

export default function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    if (password !== confirm) {
      setError('Those two passwords do not match.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => router.push('/login'), 2_000);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? Array.isArray(err.details) ? err.details.join(' ') : err.message
          : 'Something went wrong. Please try again.',
      );
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">Link not valid</h1>
        <p className="mt-2 text-md text-[var(--text-secondary)]">
          This reset link is missing or malformed. Request a new one.
        </p>
        <Link href="/forgot-password" className="mt-6 inline-block">
          <Button variant="primary">Request a new link</Button>
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--color-positive-50)] text-[var(--color-positive-600)] dark:bg-[rgb(16_185_129/0.12)]">
          <ShieldCheck className="size-6" strokeWidth={1.5} />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-[-0.025em]">Password updated</h1>
        <p className="mt-2 text-md text-[var(--text-secondary)]">
          Every other device has been signed out. Taking you to sign in…
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">Set a new password</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        Choose something long. This will sign you out everywhere else.
      </p>

      {error && <Alert tone="critical" className="mt-5">{error}</Alert>}

      <form method="post" onSubmit={onSubmit} className="mt-6 space-y-4">
        <Field label="New password">
          {(props) => (
            <PasswordInput
              {...props}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          )}
        </Field>

        <Field label="Confirm new password">
          {(props) => (
            <PasswordInput
              {...props}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          )}
        </Field>

        <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
          Update password
        </Button>
      </form>
    </div>
  );
}
