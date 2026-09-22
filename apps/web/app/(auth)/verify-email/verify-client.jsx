'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { BadgeCheck, XCircle, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

export default function VerifyClient() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState('working');

  useEffect(() => {
    if (!token) {
      setState('failed');
      return;
    }
    api
      .post('/auth/verify-email', { token })
      .then(() => setState('done'))
      .catch(() => setState('failed'));
  }, [token]);

  if (state === 'working') {
    return (
      <div className="text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-[var(--text-tertiary)]" />
        <p className="mt-4 text-md text-[var(--text-secondary)]">Confirming your email…</p>
      </div>
    );
  }

  const ok = state === 'done';

  return (
    <div className="text-center">
      <div
        className={
          ok
            ? 'mx-auto flex size-12 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--color-positive-50)] text-[var(--color-positive-600)] dark:bg-[rgb(16_185_129/0.12)]'
            : 'mx-auto flex size-12 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--color-critical-50)] text-[var(--color-critical-600)] dark:bg-[rgb(239_68_68/0.12)]'
        }
      >
        {ok ? <BadgeCheck className="size-6" strokeWidth={1.5} /> : <XCircle className="size-6" strokeWidth={1.5} />}
      </div>

      <h1 className="mt-5 text-2xl font-semibold tracking-[-0.025em]">
        {ok ? 'Email confirmed' : 'That link did not work'}
      </h1>
      <p className="mt-2 text-md text-[var(--text-secondary)]">
        {ok
          ? 'Thanks — your account is fully set up.'
          : 'Verification links expire after 48 hours. Request a fresh one from your profile settings.'}
      </p>

      <Link href={ok ? '/dashboard' : '/settings/profile'} className="mt-6 inline-block">
        <Button variant="primary">{ok ? 'Go to dashboard' : 'Open settings'}</Button>
      </Link>
    </div>
  );
}
