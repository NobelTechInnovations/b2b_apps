'use client';

import { useState } from 'react';
import { Save, BadgeCheck, MailWarning } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardHeader, CardBody, CardFooter, PageHeader, Avatar, Alert } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Input, Field, Select, PasswordInput } from '@/components/ui/input';
import { EmailChangeForm } from '@/components/account/email-change-form';

const TIMEZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London',
  'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC',
];

export default function ProfileClient({ user }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: user?.name ?? '',
    phone: user?.phone ?? '',
    timezone: user?.timezone ?? 'Asia/Kolkata',
  });
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });
  const [busy, setBusy] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState(null);

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  async function saveProfile(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.patch('/account/profile', form);
      toast.success('Profile updated');
    } catch (error) {
      toast.error('Could not save your profile', {
        description: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    setPwBusy(true);
    setPwError(null);
    try {
      const response = await api.post('/auth/change-password', passwords);
      setPasswords({ current_password: '', new_password: '' });
      toast.success('Password changed', {
        description: `${response.data.other_sessions_ended} other session${
          response.data.other_sessions_ended === 1 ? '' : 's'
        } signed out.`,
      });
    } catch (error) {
      setPwError(
        error instanceof ApiError
          ? Array.isArray(error.details) ? error.details.join(' ') : error.message
          : 'Could not change your password.',
      );
    } finally {
      setPwBusy(false);
    }
  }

  async function resendVerification() {
    await api.post('/auth/resend-verification', {}).catch(() => {});
    toast.success('Verification email sent');
  }

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Your profile" description="This is how you appear across every workspace you belong to." />

      {user && !user.email_verified && (
        <Alert
          tone="caution"
          icon={MailWarning}
          action={<Button variant="ghost" size="xs" onClick={resendVerification}>Resend</Button>}
        >
          Your email address is not confirmed yet.
        </Alert>
      )}

      <form onSubmit={saveProfile}>
        <Card>
          <CardHeader title="Details" />
          <CardBody className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar name={form.name} src={user?.avatar_url} size="xl" />
              <div>
                <Button variant="secondary" size="sm" type="button">Upload photo</Button>
                <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">JPG or PNG, up to 2 MB.</p>
              </div>
            </div>

            <Field label="Full name" required>
              {(props) => <Input {...props} value={form.name} onChange={set('name')} required />}
            </Field>

            <Field label="Email address">
              {(props) => (
                <Input
                  {...props}
                  value={user?.email ?? ''}
                  disabled
                  suffix={
                    user?.email_verified ? (
                      <BadgeCheck className="size-4 text-[var(--color-positive-500)]" />
                    ) : null
                  }
                />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone">
                {(props) => <Input {...props} placeholder="+91 98765 43210" value={form.phone} onChange={set('phone')} />}
              </Field>
              <Field label="Time zone">
                {(props) => (
                  <Select {...props} value={form.timezone} onChange={set('timezone')}>
                    {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </Select>
                )}
              </Field>
            </div>
          </CardBody>
          <CardFooter>
            <Button type="submit" variant="primary" icon={Save} loading={busy}>Save changes</Button>
          </CardFooter>
        </Card>
      </form>

      <Card>
        <CardHeader title="Change sign-in email" />
        <CardBody>
          <EmailChangeForm currentEmail={user?.email} />
        </CardBody>
      </Card>

      <form onSubmit={changePassword}>
        <Card>
          <CardHeader
            title="Password"
            description="Changing your password signs you out of every other device."
          />
          <CardBody className="space-y-4">
            {pwError && <Alert tone="critical">{pwError}</Alert>}

            <Field label="Current password">
              {(props) => (
                <PasswordInput
                  {...props}
                  autoComplete="current-password"
                  value={passwords.current_password}
                  onChange={(e) => setPasswords((p) => ({ ...p, current_password: e.target.value }))}
                  required
                />
              )}
            </Field>

            <Field label="New password" hint="At least 10 characters, with a number or symbol.">
              {(props) => (
                <PasswordInput
                  {...props}
                  autoComplete="new-password"
                  value={passwords.new_password}
                  onChange={(e) => setPasswords((p) => ({ ...p, new_password: e.target.value }))}
                  required
                />
              )}
            </Field>
          </CardBody>
          <CardFooter>
            <Button type="submit" variant="secondary" loading={pwBusy}>Change password</Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}
