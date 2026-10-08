'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Mail, BadgeCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';

export default function ConfirmEmailChange() {
  const token = useSearchParams().get('token');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/confirm-email-change', { token });
      setDone(true);
      window.history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm the email change.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {done ? <BadgeCheck className="size-8 text-[var(--color-positive-600)]" /> : <Mail className="size-8 text-[var(--text-secondary)]" />}
      <h1 className="text-2xl font-semibold">{done ? 'Email updated' : 'Confirm your new email'}</h1>
      <p className="text-base text-[var(--text-secondary)]">
        {done ? 'Sign in with your new email and existing password. Your workspaces and employee records are unchanged.'
          : 'Your sign-in email will change and existing sessions will end. Your password stays the same.'}
      </p>
      {(error || !token && !done) && <Alert tone="critical">{error ?? 'The confirmation token is missing. Request a new link from your profile.'}</Alert>}
      {done ? <Link href="/login"><Button variant="primary">Sign in</Button></Link>
        : <Button variant="primary" icon={Mail} onClick={confirm} disabled={!token} loading={busy}>Confirm email change</Button>}
    </div>
  );
}
