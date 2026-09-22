'use client';

import { useState } from 'react';
import { Monitor, LogOut, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { relativeTime, date } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardHeader, Badge, PageHeader, Alert } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';

export default function SecurityClient({ initialSessions }) {
  const toast = useToast();
  const [sessions, setSessions] = useState(initialSessions);
  const [busy, setBusy] = useState(null);

  async function endSession(session) {
    setBusy(session.id);
    try {
      await api.del(`/account/sessions/${session.id}`);
      setSessions((current) => current.filter((s) => s.id !== session.id));
      toast.success('That device has been signed out');
    } catch {
      toast.error('Could not end that session');
    } finally {
      setBusy(null);
    }
  }

  async function endAll() {
    await api.post('/auth/logout-all', {}).catch(() => {});
    window.location.href = '/login';
  }

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title="Security & sessions"
        description="Everywhere you are currently signed in. One sign-in covers every app in the workspace."
      />

      <Alert tone="info" icon={ShieldCheck}>
        Your password is stored with argon2id and never leaves the identity service.
        Access tokens expire every 10 minutes and renew silently.
      </Alert>

      <Card className="divide-y divide-[var(--border-subtle)]">
        <CardHeader
          title="Active sessions"
          description={`${sessions.length} device${sessions.length === 1 ? '' : 's'}`}
          action={
            sessions.length > 1 && (
              <Button variant="danger-ghost" size="sm" icon={LogOut} onClick={endAll}>
                Sign out everywhere
              </Button>
            )
          }
        />

        {sessions.map((session) => (
          <div key={session.id} className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
              <Monitor className="size-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-base font-medium">
                {session.device_label ?? 'Unknown device'}
                {session.current && <Badge size="sm" tone="positive">This device</Badge>}
              </p>
              <p className="truncate text-xs text-[var(--text-tertiary)]">
                {session.ip} · last used {relativeTime(session.last_used_at)} · signed in {date(session.created_at)}
              </p>
            </div>
            {!session.current && (
              <Button
                variant="ghost"
                size="sm"
                loading={busy === session.id}
                onClick={() => endSession(session)}
              >
                End
              </Button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
