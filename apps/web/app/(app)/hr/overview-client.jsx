'use client';

import Link from 'next/link';
import {
  Users, UserCheck, CalendarOff, Clock, Plus, ArrowUpRight, Cake, PartyPopper,
  UserPlus, CheckCheck, Network,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { date, relativeTime } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { StatTile } from '@/components/data/stat-tile';
import { Avatar, Badge, Card, CardHeader, CardBody, EmptyState, PageHeader, Alert } from '@/components/ui/primitives';

export default function OverviewClient({ overview, error }) {
  if (error) {
    return <Alert tone="critical">We could not load HR right now. {error.message}</Alert>;
  }

  const { people, today, pending_leave: pending, by_department: departments, occasions, recent_joiners: joiners } = overview;
  const peak = Math.max(...departments.map((d) => d.headcount), 1);
  const attendanceRate = today.total > 0 ? Math.round((today.present / today.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="HR"
        description="Your team today — who is in, who is away, and what needs a decision."
        actions={
          <div className="flex gap-2">
            <Can permission="hr.employees.create">
              <Link href="/hr/employees?new=1">
                <Button variant="secondary" icon={Plus}>Add employee</Button>
              </Link>
            </Can>
            <Can permission="hr.attendance.view">
              <Link href="/hr/attendance"><Button variant="primary">Attendance</Button></Link>
            </Can>
          </div>
        }
      />

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Headcount" value={people.headcount} icon={Users} tone="brand"
          hint={people.joined_this_month > 0 ? `${people.joined_this_month} joined this month` : 'No new joiners'}
        />
        <StatTile
          label="In today" value={today.present} icon={UserCheck} tone="positive"
          hint={`${attendanceRate}% of the team`}
        />
        <StatTile label="On leave" value={today.on_leave} icon={CalendarOff} />
        <StatTile
          label="Awaiting approval" value={pending.length} icon={Clock}
          tone={pending.length > 0 ? 'caution' : 'neutral'}
          hint={pending.length > 0 ? 'Leave requests' : 'Nothing pending'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── leave approvals ─────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Leave awaiting your decision"
            description={pending.length > 0 ? `${pending.length} pending` : undefined}
            action={
              <Link href="/hr/leave">
                <Button variant="ghost" size="xs" iconRight={ArrowUpRight}>All leave</Button>
              </Link>
            }
          />
          <CardBody className="pt-0">
            {pending.length === 0 ? (
              <EmptyState
                icon={CheckCheck}
                title="Nothing to approve"
                description="Every leave request has been dealt with."
              />
            ) : (
              <ul className="-mx-1 space-y-0.5">
                {pending.map((request) => (
                  <li key={request.id}>
                    <Link
                      href="/hr/leave"
                      className="flex items-center gap-3 rounded-[var(--radius-md)] px-1 py-2.5 transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <Avatar name={request.employee_name} size="md" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-medium">{request.employee_name}</p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">
                          {request.leave_type_name} · {date(request.start_date, 'short')} – {date(request.end_date, 'short')}
                        </p>
                      </div>
                      <Badge size="sm" tone="caution">
                        {request.days} {Number(request.days) === 1 ? 'day' : 'days'}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* ── occasions ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title="This week" description="Birthdays & anniversaries" />
          <CardBody className="pt-0">
            {occasions.length === 0 ? (
              <EmptyState icon={Cake} title="Nothing coming up" description="No occasions in the next week." />
            ) : (
              <ul className="-mx-1 space-y-0.5">
                {occasions.map((person) => (
                  <li key={`${person.id}-${person.occasion}`} className="flex items-center gap-2.5 px-1 py-2">
                    <Avatar name={person.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base">{person.name}</p>
                      <p className="flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
                        {person.occasion === 'birthday' ? (
                          <><Cake className="size-3" /> Birthday</>
                        ) : (
                          <><PartyPopper className="size-3" /> Work anniversary</>
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── departments ─────────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Headcount by department"
            action={
              <Link href="/hr/departments">
                <Button variant="ghost" size="xs" iconRight={ArrowUpRight}>Manage</Button>
              </Link>
            }
          />
          <CardBody>
            {departments.length === 0 ? (
              <EmptyState
                icon={Network}
                title="No departments yet"
                description="Group your team so reporting lines and headcount make sense."
                action={
                  <Can permission="hr.departments.manage">
                    <Link href="/hr/departments">
                      <Button variant="secondary" size="sm">Create a department</Button>
                    </Link>
                  </Can>
                }
              />
            ) : (
              <div className="space-y-3">
                {departments.map((department) => (
                  <div key={department.id}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm">{department.name}</span>
                      <span className="text-sm font-medium tabular">{department.headcount}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[var(--color-brand-500)] to-[var(--color-brand-400)] transition-all duration-700"
                        style={{ width: `${Math.max((department.headcount / peak) * 100, department.headcount > 0 ? 4 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── recent joiners ──────────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Recently joined" />
          <CardBody className="pt-0">
            {joiners.length === 0 ? (
              <EmptyState icon={UserPlus} title="No one yet" />
            ) : (
              <ul className="-mx-1 space-y-0.5">
                {joiners.map((person) => (
                  <li key={person.id}>
                    <Link
                      href={`/hr/employees?open=${person.id}`}
                      className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-1 py-2 transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <Avatar name={person.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base">{person.name}</p>
                        <p className="truncate text-xs text-[var(--text-tertiary)]">
                          {person.designation ?? 'Joined'} · {relativeTime(person.joined_on)}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
