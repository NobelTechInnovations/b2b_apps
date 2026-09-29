'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Mail, ArrowLeft, MailCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setLoading(true);
    // The endpoint answers identically whether or not the account exists, so
    // this page must not reveal anything either.
    await api.post('/auth/forgot-password', { email }).catch(() => {});
    setSent(true);
    setLoading(false);
  }

  if (sent) {
    return (
      <div className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--color-brand-50)] text-[var(--color-brand-600)] dark:bg-[rgb(99_102_241/0.12)]">
          <MailCheck className="size-6" strokeWidth={1.5} />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-[-0.025em]">Check your inbox</h1>
        <p className="mt-2 text-md text-[var(--text-secondary)]">
          If an account exists for <span className="font-medium text-[var(--text-primary)]">{email}</span>,
          we have sent a link to reset your password. It expires in one hour.
        </p>
        <Link href="/login" className="mt-6 inline-block">
          <Button variant="secondary" icon={ArrowLeft}>Back to sign in</Button>
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">Reset your password</h1>
      <p className="mt-1.5 text-md text-[var(--text-secondary)]">
        Enter your email and we will send you a reset link.
      </p>

      <form method="post" onSubmit={onSubmit} className="mt-6 space-y-4">
        <Field label="Work email">
          {(props) => (
            <Input
              {...props}
              type="email"
              placeholder="you@company.com"
              icon={Mail}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          )}
        </Field>

        <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
          Send reset link
        </Button>
      </form>

      <Link
        href="/login"
        className="mt-6 flex items-center justify-center gap-1.5 text-base text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="size-4" />
        Back to sign in
      </Link>
    </div>
  );
}
