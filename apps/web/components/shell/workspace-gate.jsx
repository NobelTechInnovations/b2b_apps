'use client';

import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { apexUrl } from '@/lib/tenant';
import { Button } from '@/components/ui/button';

/** Shown instead of the shell when the address and the session disagree. */
export function WorkspaceGate({ switchTo, noAccess }) {
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!switchTo) return;
    api
      .post('/auth/switch-org', { org_id: switchTo.id })
      .then(() => window.location.reload())
      .catch((e) => setError(e.message));
  }, [switchTo]);

  async function signOut() {
    await api.post('/auth/logout').catch(() => {});
    window.location.href = apexUrl('/login');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-page)] p-6">
      <div className="max-w-sm text-center">
        {switchTo && !error ? (
          <>
            <Loader2 className="mx-auto size-6 animate-spin text-[var(--text-tertiary)]" />
            <p className="mt-4 text-base">Opening {switchTo.name}…</p>
          </>
        ) : (
          <>
            <ShieldAlert className="mx-auto size-8 text-[var(--color-critical-500)]" />
            <h1 className="mt-4 text-lg font-semibold">You don&apos;t have access to this workspace</h1>
            <p className="mt-2 text-base text-[var(--text-secondary)]">
              {error ?? `You are signed in, but not as a member of “${noAccess?.tenant}”. Ask its owner to invite you.`}
            </p>
            <div className="mt-6 flex justify-center gap-2">
              {noAccess?.home && (
                <a href={noAccess.home}><Button variant="primary">Go to {noAccess.homeName}</Button></a>
              )}
              <Button variant="secondary" onClick={signOut}>Sign in as someone else</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
