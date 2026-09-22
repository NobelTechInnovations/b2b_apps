'use client';

import Link from 'next/link';
import { ArrowUpRight, Store, Sparkles, UserPlus, Rocket, CheckCircle2, Circle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/lib/workspace';
import { Card, CardHeader, CardBody, EmptyState, PageHeader, Badge } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Icon, tintFor } from '@/components/shell/icon';

const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

/**
 * The dashboard is assembled from whatever the workspace has installed. A CRM
 * customer and a manufacturing customer see completely different pages without
 * a single conditional in this file naming either app.
 */
export default function DashboardClient({ organization }) {
  const { user, widgets, navigation, workspace } = useWorkspace();
  const firstName = user?.name?.split(' ')[0] ?? 'there';

  const small = widgets.filter((w) => w.size === 'sm');
  const medium = widgets.filter((w) => w.size === 'md');
  const large = widgets.filter((w) => w.size === 'lg');

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={
          organization?.name
            ? `Here is what is happening across ${organization.name}.`
            : 'Here is what is happening across your workspace.'
        }
        actions={
          <Link href="/apps">
            <Button variant="secondary" icon={Store}>Browse apps</Button>
          </Link>
        }
      />

      {navigation.length === 0 ? (
        <Onboarding organization={organization} />
      ) : (
        <>
          {small.length > 0 && (
            <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
              {small.map((widget) => <MetricWidget key={widget.id} widget={widget} />)}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            {large.map((widget) => (
              <PanelWidget key={widget.id} widget={widget} className="lg:col-span-2" />
            ))}
            {medium.map((widget) => <PanelWidget key={widget.id} widget={widget} />)}
          </div>

          {widgets.length === 0 && (
            <Card>
              <EmptyState
                icon={Sparkles}
                title="Your apps are ready"
                description="Widgets appear here as soon as there is data in the apps you have installed."
              />
            </Card>
          )}
        </>
      )}

      <QuickLinks navigation={navigation} isOwner={workspace?.member?.is_owner} />
    </div>
  );
}

/* ── widgets ──────────────────────────────────────────────────────────────── */

function MetricWidget({ widget }) {
  const app = useWorkspace().navigation.find((a) => a.slug === widget.app);

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm text-[var(--text-secondary)]">{widget.title}</p>
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]', tintFor(app?.color))}>
          <Icon name={app?.icon} className="size-3.5" strokeWidth={2} />
        </span>
      </div>
      <p className="metric mt-2.5 text-2xl font-semibold tracking-[-0.02em] text-[var(--text-disabled)]">—</p>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">No data yet</p>
    </Card>
  );
}

function PanelWidget({ widget, className }) {
  const app = useWorkspace().navigation.find((a) => a.slug === widget.app);

  return (
    <Card className={className}>
      <CardHeader
        title={widget.title}
        action={
          app && (
            <Link href={app.items[0]?.path ?? '#'}>
              <Button variant="ghost" size="xs" iconRight={ArrowUpRight}>Open {app.label}</Button>
            </Link>
          )
        }
      />
      <CardBody>
        <div className="flex h-40 flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] text-center">
          <p className="text-base text-[var(--text-secondary)]">Nothing to show yet</p>
          <p className="mt-1 max-w-xs text-xs text-[var(--text-tertiary)]">
            This fills in automatically once {app?.label ?? 'the app'} has records.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

/* ── first-run ────────────────────────────────────────────────────────────── */

function Onboarding({ organization }) {
  const steps = [
    { label: 'Create your workspace', done: true, href: null },
    { label: 'Install your first app', done: false, href: '/apps', icon: Store },
    { label: 'Invite your team', done: (organization?.counts?.members ?? 1) > 1, href: '/settings/members', icon: UserPlus },
  ];

  return (
    <Card className="overflow-hidden">
      <div className="relative border-b border-[var(--border-subtle)] bg-gradient-to-br from-[var(--color-brand-50)] to-transparent px-6 py-7 dark:from-[rgb(99_102_241/0.08)]">
        <div className="flex size-10 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-brand-600)] text-white">
          <Rocket className="size-5" strokeWidth={1.75} />
        </div>
        <h2 className="mt-4 text-lg font-semibold tracking-[-0.02em]">
          Let&apos;s get {organization?.name ?? 'your workspace'} running
        </h2>
        <p className="mt-1.5 max-w-lg text-base text-[var(--text-secondary)]">
          Your workspace is live. Now add the apps your business actually needs —
          you only pay for what you switch on, and you can change it any time.
        </p>
      </div>

      <div className="divide-y divide-[var(--border-subtle)]">
        {steps.map((step) => (
          <div key={step.label} className="flex items-center gap-3 px-6 py-3.5">
            {step.done ? (
              <CheckCircle2 className="size-5 shrink-0 text-[var(--color-positive-500)]" />
            ) : (
              <Circle className="size-5 shrink-0 text-[var(--border-strong)]" />
            )}
            <span className={cn('flex-1 text-base', step.done && 'text-[var(--text-tertiary)] line-through')}>
              {step.label}
            </span>
            {!step.done && step.href && (
              <Link href={step.href}>
                <Button variant="secondary" size="sm" icon={step.icon}>Start</Button>
              </Link>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function QuickLinks({ navigation, isOwner }) {
  if (navigation.length === 0) return null;

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-[var(--text-secondary)]">Your apps</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {navigation.map((app) => (
          <Link key={app.slug} href={app.items[0]?.path ?? `/${app.slug}`}>
            <Card interactive className="flex h-full items-start gap-3 p-4">
              <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)]', tintFor(app.color))}>
                <Icon name={app.icon} className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-base font-medium">{app.label}</p>
                <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">
                  {app.items.length} section{app.items.length === 1 ? '' : 's'}
                </p>
              </div>
            </Card>
          </Link>
        ))}

        {isOwner && (
          <Link href="/apps">
            <Card
              interactive
              className="flex h-full items-center justify-center gap-2 border-dashed p-4 text-[var(--text-secondary)]"
            >
              <Store className="size-4" />
              <span className="text-base font-medium">Add an app</span>
            </Card>
          </Link>
        )}
      </div>
    </div>
  );
}
