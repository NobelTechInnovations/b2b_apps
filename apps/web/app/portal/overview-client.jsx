'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Clock, CalendarOff, Receipt, FileText, Target, AlertTriangle,
  TrendingUp, CalendarCheck, ChevronRight, UserRound, Building2, Briefcase,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import {
  Avatar, Badge, Card, EmptyState, Alert, Skeleton,
} from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { date as fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/lib/workspace';

export default function PortalOverview() {
  const { can, hasApp, user } = useWorkspace();
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get('/hr/me');
      setData(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      </div>
    );
  }

  // The one error worth explaining rather than showing as a red box: their
  // login works, it just is not attached to an employee record yet.
  if (error?.details?.code === 'no_employee_record' || error?.status === 403) {
    // An owner or HR admin is the HR team: let them fix it here.
    const runsHr = hasApp('hr') && can('hr.employees.create');
    async function linkMe() {
      setLinking(true);
      setLinkError(null);
      try {
        await api.post('/hr/employees/from-people', { user_ids: [user.id] });
        setLoading(true);
        await load();
      } catch (err) {
        setLinkError(err instanceof ApiError ? err.message : 'Could not create your record.');
      } finally {
        setLinking(false);
      }
    }
    return (
      <Card>
        <EmptyState
          icon={UserRound}
          title="Your login isn’t linked to an employee record yet"
          description={runsHr
            ? 'This portal is each person’s own payslips, leave and attendance. You run HR here, so you can add yourself as an employee — or go to HR admin to manage everyone.'
            : 'Ask your HR team to connect your account. Once they do, your attendance, leave, payslips and documents will appear here.'}
          action={runsHr && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" loading={linking} onClick={linkMe}>Create my employee record</Button>
              <Link href="/hr/employees"><Button variant="secondary">Open HR admin</Button></Link>
            </div>
          )}
        />
        {linkError && <div className="px-6 pb-6"><Alert tone="critical">{linkError}</Alert></div>}
      </Card>
    );
  }

  if (error) return <Alert tone="critical">{error.message}</Alert>;

  const { employee, shift, today, this_month: month, leave_balances: balances } = data;

  return (
    <div className="space-y-5">
      {/* ── who you are ──────────────────────────────────────────────── */}
      <Card className="aurora overflow-hidden">
        <div className="flex flex-wrap items-center gap-4 p-5">
          <Avatar name={employee.name} size="xl" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-[-0.02em]">{employee.name}</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-[var(--text-secondary)]">
              {employee.designation && (
                <span className="inline-flex items-center gap-1">
                  <Briefcase className="size-3.5" />{employee.designation}
                </span>
              )}
              {employee.department_name && (
                <span className="inline-flex items-center gap-1">
                  <Building2 className="size-3.5" />{employee.department_name}
                </span>
              )}
              {employee.manager_name && <span>Reports to {employee.manager_name}</span>}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="neutral" size="sm">{employee.employee_code}</Badge>
              {employee.joined_on && (
                <Badge tone="neutral" size="sm">Joined {fmtDate(employee.joined_on)}</Badge>
              )}
              {shift && <Badge tone="brand" size="sm">{shift.name} · {shift.window}</Badge>}
            </div>
          </div>
        </div>
      </Card>

      {/* ── things that want doing ───────────────────────────────────── */}
      {data.documents_to_acknowledge > 0 && (
        <Alert
          tone="caution"
          icon={AlertTriangle}
          title={`${data.documents_to_acknowledge} document${data.documents_to_acknowledge === 1 ? '' : 's'} waiting for you`}
          action={
            <Link href="/portal/documents">
              <Button variant="secondary" size="sm">Review</Button>
            </Link>
          }
        >
          Your employer has asked you to read and acknowledge these.
        </Alert>
      )}

      {data.open_review && ['self_review', 'shared'].includes(data.open_review.cycle_status ?? '') && (
        <Alert tone="info" icon={Target} title={`${data.open_review.cycle_name} is open`}
          action={<Link href="/portal/performance"><Button variant="secondary" size="sm">Open</Button></Link>}
        >
          {data.open_review.self_review_due
            ? `Your self-review is due by ${fmtDate(data.open_review.self_review_due)}.`
            : 'Your review is ready to read.'}
        </Alert>
      )}

      {/* ── today ────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="panel-hover p-4">
          <p className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
            <Clock className="size-3.5" />Today
          </p>
          {today ? (
            <>
              <p className="metric mt-2 text-xl font-semibold capitalize tracking-[-0.02em]">
                {String(today.status).replace('_', ' ')}
              </p>
              <p className="mt-1 text-xs tabular text-[var(--text-tertiary)]">
                {today.check_in_at ? fmtDate(today.check_in_at, 'time') : '—'}
                {' → '}
                {today.check_out_at ? fmtDate(today.check_out_at, 'time') : 'still in'}
                {today.worked && ` · ${today.worked}`}
              </p>
            </>
          ) : (
            <>
              <p className="metric mt-2 text-xl font-semibold tracking-[-0.02em] text-[var(--text-tertiary)]">
                Not marked
              </p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                {shift ? `Your shift is ${shift.window}` : 'No attendance recorded yet'}
              </p>
            </>
          )}
        </Card>

        <Card className="panel-hover p-4">
          <p className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
            <CalendarCheck className="size-3.5" />This month
          </p>
          <p className="metric mt-2 text-xl font-semibold tabular tracking-[-0.02em]">
            {month?.days_present ?? 0}
            <span className="ml-1 text-sm font-normal text-[var(--text-tertiary)]">days in</span>
          </p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            {month?.worked_hours ?? '0h 00m'} worked
            {month?.days_leave ? ` · ${month.days_leave} on leave` : ''}
          </p>
        </Card>

        <Card className="panel-hover p-4">
          <p className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
            <TrendingUp className="size-3.5" />Overtime
          </p>
          <p className={cn(
            'metric mt-2 text-xl font-semibold tabular tracking-[-0.02em]',
            month?.overtime_hours && month.overtime_hours !== '0h 00m'
              && 'text-[var(--color-positive-600)] dark:text-[var(--color-positive-500)]',
          )}>
            {month?.overtime_hours ?? '0h 00m'}
          </p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">this month, beyond your shift</p>
        </Card>
      </div>

      {/* ── leave ────────────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
          <h2 className="text-md font-semibold">Your leave</h2>
          <Link
            href="/portal/leave"
            className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)] hover:underline dark:text-[var(--color-brand-400)]"
          >
            Apply or review <ChevronRight className="size-3.5" />
          </Link>
        </div>

        {balances?.length ? (
          <div className="grid gap-px bg-[var(--border-subtle)] sm:grid-cols-2 lg:grid-cols-4">
            {balances.map((balance) => (
              <div key={balance.leave_type_id ?? balance.code} className="bg-[var(--surface-raised)] p-4">
                <p className="truncate text-sm text-[var(--text-secondary)]">{balance.name}</p>
                <p className="metric mt-1 text-lg font-semibold tabular">
                  {Number(balance.available)}
                  <span className="ml-1 text-xs font-normal text-[var(--text-tertiary)]">
                    of {Number(balance.entitled) + Number(balance.carried ?? 0)}
                  </span>
                </p>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-brand-500)]"
                    style={{
                      width: `${Math.min(100, Math.max(0,
                        (Number(balance.available) /
                          Math.max(1, Number(balance.entitled) + Number(balance.carried ?? 0))) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={CalendarOff} title="No leave policy yet" />
        )}
      </Card>

      {/* ── shortcuts ────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { href: '/portal/payslips', label: 'Payslips', hint: 'What you were paid', icon: Receipt },
          { href: '/portal/documents', label: 'Documents', hint: 'Letters and certificates', icon: FileText },
          { href: '/portal/performance', label: 'Performance', hint: 'Reviews and goals', icon: Target },
        ].map((item) => (
          <Link key={item.href} href={item.href}>
            <Card interactive className="panel-hover flex items-center gap-3 p-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                <item.icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block truncate text-xs text-[var(--text-tertiary)]">{item.hint}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-[var(--text-tertiary)]" />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
