'use client';

import { useEffect, useState } from 'react';
import { Mail, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';

export function EmailChangeForm({ currentEmail, userId }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    api.get('/auth/email-change', { query: { user_id: userId } })
      .then((r) => { if (active) setPending(r.data); })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post('/auth/change-email', {
        email: email.trim(), current_password: password, ...(userId ? { user_id: userId } : {}),
      });
      setPending(result.data);
      setEmail('');
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request the email change.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/cancel-email-change', userId ? { user_id: userId } : {});
      setPending(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the email change.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="critical">{error}</Alert>}
      {pending && (
        <Alert tone="caution">
          <span className="break-words">Awaiting confirmation from {pending.new_email}.</span>
          <Button type="button" variant="ghost" size="sm" icon={X} onClick={cancel} disabled={busy}>Cancel change</Button>
        </Alert>
      )}
      <Field label="Current sign-in email">
        {(props) => <Input {...props} value={currentEmail ?? ''} readOnly />}
      </Field>
      <Field label="New email address" required>
        {(props) => <Input {...props} type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} required />}
      </Field>
      <Field label={userId ? 'Your administrator password' : 'Current password'} required>
        {(props) => <PasswordInput {...props} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
      </Field>
      <Button type="submit" variant="secondary" icon={Mail} loading={busy} disabled={loading || !email.trim() || !password}>
        {pending ? 'Send new confirmation' : 'Send confirmation'}
      </Button>
    </form>
  );
}
