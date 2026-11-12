'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Server, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/input';
import { ConfirmModal } from '@/components/ui/modal';
import { Alert, Badge, Card, CardBody, CardHeader, Skeleton } from '@/components/ui/primitives';

// Common providers: picking one fills in the server and port.
const PRESETS = [
  { key: 'gmail', label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 465 },
  { key: 'zoho', label: 'Zoho Mail', host: 'smtp.zoho.in', port: 465 },
  { key: 'outlook', label: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587 },
  { key: 'hostinger', label: 'Hostinger mail', host: 'smtp.hostinger.com', port: 465 },
];

const EMPTY = { host: '', port: 465, username: '', password: '', from_email: '', from_name: '', reply_to: '', enabled: true };

/**
 * The workspace's own outgoing mail server. Owners and admins enter their
 * SMTP details once; every email the workspace sends then goes out through it.
 */
export function MailServerCard({ onSaved }) {
  const toast = useToast();
  const [saved, setSaved] = useState(undefined);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = (await api.get('/notifications/mail-settings')).data;
      setSaved(data);
      setEditing(!data);
      setForm(data ? { ...EMPTY, ...data, from_name: data.from_name ?? '', reply_to: data.reply_to ?? '', password: '' } : EMPTY);
    } catch (err) {
      setSaved(null);
      setProblem(err instanceof ApiError ? err.message : 'Could not load the mail settings.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const gmail = /gmail\.com$/i.test(form.host);

  function preset(p) {
    setForm((f) => ({
      ...f, host: p.host, port: p.port,
      // A Gmail login is the address mail comes from.
      ...(p.key === 'gmail' && f.username && !f.from_email ? { from_email: f.username } : {}),
    }));
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const data = (await api.put('/notifications/mail-settings', {
        host: form.host.trim(), port: Number(form.port), username: form.username.trim(),
        ...(form.password ? { password: form.password } : {}),
        from_email: (form.from_email || form.username).trim(), from_name: form.from_name.trim(),
        reply_to: form.reply_to.trim() || null, enabled: form.enabled,
      })).data;
      toast.success('Mail server saved', { description: `Signed in to ${data.host} successfully. Emails now go out from ${data.from_email}.` });
      setSaved(data);
      setEditing(false);
      setForm({ ...EMPTY, ...data, from_name: data.from_name ?? '', reply_to: data.reply_to ?? '', password: '' });
      onSaved?.();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not save the mail settings.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await api.del('/notifications/mail-settings');
      toast.success('Mail server removed', { description: 'Emails go out through the server’s own settings again.' });
      setConfirmRemove(false);
      await load();
      onSaved?.();
    } catch (err) {
      toast.error('Could not remove it', { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  if (saved === undefined) return <Card><CardBody><Skeleton className="h-24" /></CardBody></Card>;

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Server className="size-4" />Mail server (SMTP)</span>}
        description="Send this workspace’s emails — invitations, reminders, lead and task notifications — from your own mailbox, such as Gmail."
        action={saved && !editing ? (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Change</Button>
            <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => setConfirmRemove(true)}>Remove</Button>
          </div>
        ) : null}
      />
      <CardBody className="space-y-4">
        {saved && !editing && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Badge tone={saved.enabled ? 'positive' : 'neutral'} dot>{saved.enabled ? 'In use' : 'Turned off'}</Badge>
            <span>Sends from <strong>{saved.from_name ? `${saved.from_name} <${saved.from_email}>` : saved.from_email}</strong></span>
            <span className="text-[var(--text-secondary)]">via {saved.host}:{saved.port} as {saved.username}</span>
            {saved.verified_at && <span className="text-xs text-[var(--text-tertiary)]">signed in {relativeTime(saved.verified_at)}</span>}
            {!saved.has_password && <Alert tone="critical" className="w-full">The saved password can no longer be read. Click Change and enter it again.</Alert>}
          </div>
        )}

        {editing && (
          <form onSubmit={save} className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <Button key={p.key} type="button" size="sm" variant={form.host === p.host ? 'primary' : 'secondary'} onClick={() => preset(p)}>{p.label}</Button>
              ))}
            </div>
            {gmail && (
              <Alert tone="info" icon={KeyRound} title="Gmail needs an App Password">
                Your normal Gmail password will not work here. Turn on 2-Step Verification for the Google account, then create an App Password at
                {' '}<a className="underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>{' '}
                and paste its 16 letters below. Gmail sends up to about 500 emails a day (2,000 on Google Workspace), and only from this address or its verified aliases.
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field label="SMTP server" hint="For example smtp.gmail.com">
                {(p) => <Input {...p} value={form.host} onChange={set('host')} placeholder="smtp.gmail.com" required />}
              </Field>
              <Field label="Port" hint="465 (SSL) or 587">
                {(p) => <Input {...p} type="number" value={form.port} onChange={set('port')} min={1} max={65535} required />}
              </Field>
              <Field label="Username" hint={gmail ? 'Your full Gmail address.' : 'Usually the full email address.'}>
                {(p) => <Input {...p} value={form.username} onChange={set('username')} placeholder="you@gmail.com" autoComplete="off" required />}
              </Field>
              <div />
              <Field label={gmail ? 'App Password' : 'Password'} hint={saved?.has_password ? 'Leave empty to keep the saved one.' : undefined}>
                {(p) => <Input {...p} type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required={!saved?.has_password} />}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="From address" hint="Leave empty to use the username.">
                {(p) => <Input {...p} type="email" value={form.from_email} onChange={set('from_email')} placeholder={form.username || 'you@gmail.com'} />}
              </Field>
              <Field label="From name" hint="What people see as the sender.">
                {(p) => <Input {...p} value={form.from_name} onChange={set('from_name')} placeholder="FLP Worldwide" />}
              </Field>
              <Field label="Reply-to (optional)">
                {(p) => <Input {...p} type="email" value={form.reply_to} onChange={set('reply_to')} placeholder="info@yourcompany.com" />}
              </Field>
            </div>
            <Checkbox checked={form.enabled} onChange={set('enabled')} label="Use this mail server" description="Turn off to go back to the server’s own settings without deleting these." />
            {problem && <Alert tone="critical" title="Not saved">{problem}</Alert>}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={busy}>Check and save</Button>
              {saved && <Button type="button" variant="ghost" onClick={() => { setEditing(false); setProblem(null); }}>Cancel</Button>}
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">Nexus signs in to the server before saving, so a wrong password shows here straight away. The password is stored encrypted and never shown again.</p>
          </form>
        )}
        {!editing && problem && <Alert tone="critical">{problem}</Alert>}
      </CardBody>
      <ConfirmModal
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={remove}
        title="Remove this mail server?"
        description="The saved details and password are deleted. Emails go out through the server’s own settings, or are only logged if it has none."
        confirmLabel="Remove"
        danger
      />
    </Card>
  );
}
