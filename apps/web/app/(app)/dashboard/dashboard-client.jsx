'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight, Store, Sparkles, Rocket, CheckCircle2, Circle, UserPlus,
  Compass, Upload, Plus, TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { money, number, percent } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Card, CardHeader, CardBody, EmptyState, Badge } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/shell/icon';
import { tintFor } from '@/lib/app-theme';
import { Tour, useTour } from '@/components/tour/tour';

const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

const TOUR_STEPS = [
  {
    target: 'sidebar',
    title: 'Your apps live here',
    body: 'Only the apps this workspace pays for appear in the sidebar. Switch one on in the marketplace and it shows up immediately — switch it off and it disappears, from the menu and from the API.',
  },
  {
    target: 'workspace-switcher',
    title: 'One login, many workspaces',
    body: 'If you belong to more than one company, switch between them here. Your permissions are evaluated fresh for each one.',
  },
  {
    target: 'search',
    title: 'Jump anywhere, fast',
    body: 'Press ⌘K from any screen to search and navigate. It only ever offers pages you actually have access to.',
  },
  {
    target: 'metrics',
    title: 'Numbers from every app',
    body: 'These tiles are assembled from whichever apps you have installed. Add CRM and pipeline figures appear; add HR and headcount joins them. Nothing here is hardcoded.',
  },
  {
    target: 'quick-actions',
    title: 'Start something',
    body: 'The fastest route into the work — capture a lead, hire someone, or import a spreadsheet straight into CRM or HR.',
  },
  {
    target: 'apps-grid',
    title: 'Everything you have switched on',
    body: 'Jump into any installed app from here. Browse the marketplace whenever you need another one — you are only billed for what is active.',
  },
];

export default function DashboardClient({ organization, widgetData }) {
  const { user, widgets, navigation, workspace } = useWorkspace();
  const tour = useTour('nexus-tour-dashboard');
  const firstName = user?.name?.split(' ')[0] ?? 'there';

  const hasApps = navigation.length > 0;
  const metrics = widgets.filter((w) => w.size === 'sm').slice(0, 4);

  return (
    <div className="space-y-6">
      {/* ── hero band ─────────────────────────────────────────────────────── */}
      <section className="aurora panel sheen relative overflow-hidden px-6 py-7 lg:px-8">
        <div className="fine-grid pointer-events-none absolute inset-0" />

        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <span className="flex size-5 items-center justify-center rounded-full bg-[var(--color-brand-600)] text-white">
                <Sparkles className="size-3" strokeWidth={2.5} />
              </span>
              {organization?.name ?? 'Your workspace'}
            </p>
            <h1 className="mt-2.5 text-[28px] font-semibold leading-tight tracking-[-0.03em] lg:text-[34px]">
              {greeting()}, <span className="gradient-text">{firstName}</span>
            </h1>
            <p className="mt-1.5 max-w-lg text-base text-[var(--text-secondary)]">
              {hasApps
                ? `${navigation.length} app${navigation.length === 1 ? '' : 's'} running, all sharing the same people, customers and documents.`
                : 'Your workspace is live. Add your first app to get going.'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" icon={Compass} onClick={tour.start}>
              {tour.seen ? 'Replay tour' : 'Take the tour'}
            </Button>
            <Link href="/apps">
              <Button variant="primary" className="cta" icon={Store}>Browse apps</Button>
            </Link>
          </div>
        </div>
      </section>

      {!hasApps ? (
        <FirstRun organization={organization} />
      ) : (
        <>
          {/* ── metrics ───────────────────────────────────────────────────── */}
          {metrics.length > 0 && (
            <div data-tour="metrics" className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
              {metrics.map((widget) => (
                <MetricTile
                  key={widget.id}
                  widget={widget}
                  value={widgetData?.[widget.id]}
                  app={navigation.find((a) => a.slug === widget.app)}
                />
              ))}
            </div>
          )}

          <QuickActions navigation={navigation} />

          <AppsGrid navigation={navigation} isOwner={workspace?.member?.is_owner} />
        </>
      )}

      <Tour
        steps={TOUR_STEPS}
        open={tour.open}
        onClose={tour.close}
        onFinish={tour.markSeen}
        storageKey="nexus-tour-dashboard"
      />
    </div>
  );
}

/* ── metric tile ──────────────────────────────────────────────────────────── */

function MetricTile({ widget, value, app }) {
  const hasValue = value !== undefined && value !== null;

  const rendered = !hasValue
    ? '—'
    : value.format === 'money'
      ? money(value.value, 'INR', { compact: Number(value.value) >= 100000 })
      : value.format === 'percent'
        ? percent(value.value)
        : number(value.value);

  const meaningful = hasValue && Number(value.value) > 0;

  return (
    <Link href={app?.items?.[0]?.path ?? '#'} className="group">
      <div className="panel panel-hover relative overflow-hidden p-4">
        {/* A tint that belongs to the owning app, not generic grey. */}
        <span
          className={cn(
            'absolute inset-x-0 top-0 h-0.5 opacity-70',
            meaningful ? 'bg-gradient-to-r from-[var(--color-brand-500)] to-[var(--color-brand-300)]' : 'bg-[var(--border-default)]',
          )}
        />

        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm text-[var(--text-secondary)]">{widget.title}</p>
          <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]', tintFor(app?.color))}>
            <Icon name={app?.icon} className="size-3.5" strokeWidth={2} />
          </span>
        </div>

        <p className={cn(
          'metric mt-2.5 text-[26px] font-semibold leading-none tracking-[-0.03em]',
          meaningful ? 'text-[var(--text-primary)]' : 'text-[var(--text-disabled)]',
        )}>
          {rendered}
        </p>

        <p className="mt-2 flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
          {meaningful ? (
            <>
              <TrendingUp className="size-3 text-[var(--color-positive-500)]" />
              {app?.label}
            </>
          ) : (
            <span className="opacity-0 transition-opacity group-hover:opacity-100">
              Open {app?.label} <ArrowUpRight className="inline size-3" />
            </span>
          )}
        </p>
      </div>
    </Link>
  );
}

/* ── quick actions ────────────────────────────────────────────────────────── */

function QuickActions({ navigation }) {
  const has = (slug) => navigation.some((a) => a.slug === slug);

  const actions = [
    has('crm') && { href: '/crm/leads?new=1', label: 'Capture a lead', hint: 'CRM', icon: Plus, accent: 'var(--color-brand-600)' },
    has('hr') && { href: '/hr/employees?new=1', label: 'Add an employee', hint: 'HR', icon: UserPlus, accent: '#10b981' },
    has('documents') && { href: '/documents', label: 'Import a spreadsheet', hint: 'Documents → CRM or HR', icon: Upload, accent: '#0ea5e9' },
    has('crm') && { href: '/crm/pipeline', label: 'Open the pipeline', hint: 'CRM', icon: TrendingUp, accent: '#8b5cf6' },
  ].filter(Boolean);

  if (!actions.length) return null;

  return (
    <div data-tour="quick-actions">
      <h2 className="mb-3 text-sm font-medium text-[var(--text-secondary)]">Start something</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {actions.map((action) => (
          <Link key={action.href} href={action.href}>
            <div className="panel panel-hover group flex h-full items-center gap-3 p-4">
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] transition-transform duration-200 group-hover:scale-105"
                style={{
                  background: `color-mix(in srgb, ${action.accent} 12%, transparent)`,
                  color: action.accent,
                }}
              >
                <action.icon className="size-4" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-base font-medium">{action.label}</p>
                <p className="truncate text-xs text-[var(--text-tertiary)]">{action.hint}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── apps ─────────────────────────────────────────────────────────────────── */

function AppsGrid({ navigation, isOwner }) {
  return (
    <div data-tour="apps-grid">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--text-secondary)]">Your apps</h2>
        <Link href="/apps" className="text-sm font-medium text-[var(--text-brand)] hover:underline">
          Browse all
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {navigation.map((app) => (
          <Link key={app.slug} href={app.items[0]?.path ?? `/${app.slug}`}>
            <div className="panel panel-hover group flex h-full flex-col p-4">
              <div className="flex items-start gap-3">
                <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)] transition-transform duration-200 group-hover:scale-105', tintFor(app.color))}>
                  <Icon name={app.icon} className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-base font-medium">{app.label}</p>
                  <p className="mt-0.5 truncate text-xs text-[var(--text-tertiary)]">
                    {app.items.length} section{app.items.length === 1 ? '' : 's'}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1">
                {app.items.slice(0, 3).map((item) => (
                  <span key={item.path} className="rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-2xs text-[var(--text-secondary)]">
                    {item.label}
                  </span>
                ))}
                {app.items.length > 3 && (
                  <span className="px-1 py-0.5 text-2xs text-[var(--text-disabled)]">
                    +{app.items.length - 3}
                  </span>
                )}
              </div>
            </div>
          </Link>
        ))}

        {isOwner && (
          <Link href="/apps">
            <div className="panel panel-hover flex h-full items-center justify-center gap-2 border-dashed p-4 text-[var(--text-secondary)]">
              <Store className="size-4" />
              <span className="text-base font-medium">Add an app</span>
            </div>
          </Link>
        )}
      </div>
    </div>
  );
}

/* ── first run ────────────────────────────────────────────────────────────── */

function FirstRun({ organization }) {
  const steps = [
    { label: 'Create your workspace', done: true },
    { label: 'Install your first app', done: false, href: '/apps', icon: Store },
    { label: 'Invite your team', done: (organization?.counts?.members ?? 1) > 1, href: '/settings/members', icon: UserPlus },
  ];

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--border-subtle)] px-6 py-7">
        <div className="flex size-10 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-brand-600)] text-white shadow-[var(--glow-brand)]">
          <Rocket className="size-5" strokeWidth={1.75} />
        </div>
        <h2 className="mt-4 text-lg font-semibold tracking-[-0.02em]">
          Let&apos;s get {organization?.name ?? 'your workspace'} running
        </h2>
        <p className="mt-1.5 max-w-lg text-base text-[var(--text-secondary)]">
          Add the apps your business actually needs. You only pay for what you
          switch on, and you can change it any time.
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
