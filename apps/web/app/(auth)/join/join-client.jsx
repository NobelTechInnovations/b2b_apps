'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, XCircle, ArrowRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Alert } from '@/components/ui/primitives';

export default function JoinClient() {
  const router = useRouter();
  const token = useSearchParams().get('token');

  const [invitation, setInvitation] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    api
      .get(`/invitations/preview/${encodeURIComponent(token)}`)
      .then((response) => {
        setInvitation(response.data);
        setState('ready');
      })
      .catch(() => setState('invalid'));
  }, [token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/invitations/accept', { token });
      await api.post('/auth/refresh', {});
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      // Not signed in yet — send them through sign-up carrying the invitation.
      if (err instanceof ApiError && err.status === 401) {
        router.push(`/signup?token=${encodeURIComponent(token)}`);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not join that workspace.');
      setBusy(false);
    }
  }

  if (state === 'loading') {
    return (
      <div className="text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-[var(--text-tertiary)]" />
        <p className="mt-4 text-md text-[var(--text-secondary)]">Looking up your invitation…</p>
      </div>
    );
  }

  if (state === 'invalid') {
    return (
      <div className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--color-critical-50)] text-[var(--color-critical-600)] dark:bg-[rgb(239_68_68/0.12)]">
          <XCircle className="size-6" strokeWidth={1.5} />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-[-0.025em]">Invitation not valid</h1>
        <p className="mt-2 text-md text-[var(--text-secondary)]">
          This link has expired or has already been used. Ask whoever invited you to send a new one.
        </p>
        <Link href="/login" className="mt-6 inline-block">
          <Button variant="secondary">Go to sign in</Button>
        </Link>
      </div>
    );
  }

  return (
    <div>
      <Avatar name={invitation.organization.name} src={invitation.organization.logo_url} size="xl" square />

      <h1 className="mt-5 text-2xl font-semibold tracking-[-0.025em]">
        Join {invitation.organization.name}
      </h1>
      <p className="mt-2 text-md text-[var(--text-secondary)]">
        You have been invited as{' '}
        <span className="font-medium text-[var(--text-primary)]">{invitation.email}</span>
        {invitation.title ? `, working as ${invitation.title}` : ''}.
      </p>

      {invitation.roles?.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {invitation.roles.map((role) => (
            <Badge key={role} tone="brand">{role}</Badge>
          ))}
        </div>
      )}

      {error && <Alert tone="critical" className="mt-5">{error}</Alert>}

      <Button
        variant="primary"
        size="lg"
        className="mt-7 w-full"
        loading={busy}
        onClick={accept}
        iconRight={ArrowRight}
      >
        {invitation.has_account ? 'Join workspace' : 'Create your account'}
      </Button>

      <p className="mt-4 text-center text-xs text-[var(--text-tertiary)]">
        This invitation expires {new Date(invitation.expires_at).toLocaleDateString()}.
      </p>
    </div>
  );
}
