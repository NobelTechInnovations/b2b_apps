'use client';

import Link from 'next/link';
import { Hammer, Lock, ArrowRight, Check, Store } from 'lucide-react';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import { Can } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Card, PageHeader, Badge } from '@/components/ui/primitives';
import { Icon } from '@/components/shell/icon';
import { tintFor } from '@/lib/app-theme';

/**
 * Three honest states, instead of one dead end:
 *   not entitled  → here is what it costs and how to add it
 *   entitled      → it is on your plan and we are building the screens
 *   coming soon   → it is not available to anyone yet
 */
export default function AppPlaceholder({ app, entitled, installed }) {
  const comingSoon = app.status === 'coming_soon';
  const active = entitled && installed;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={app.name}
        description={app.tagline}
        actions={
          active ? (
            <Badge tone="positive" dot>Active on your plan</Badge>
          ) : comingSoon ? (
            <Badge tone="neutral">Coming soon</Badge>
          ) : (
            <Badge tone="caution">Not on your plan</Badge>
          )
        }
      />

      <Card className="overflow-hidden">
        <div className="aurora relative px-8 py-12 text-center">
          <div className="fine-grid pointer-events-none absolute inset-0" />

          <div className="relative">
            <span
              className={cn(
                'mx-auto flex size-14 items-center justify-center rounded-[var(--radius-2xl)]',
                tintFor(app.color),
              )}
            >
              <Icon name={app.icon} className="size-7" />
            </span>

            <h2 className="mt-5 text-xl font-semibold tracking-[-0.02em]">
              {active
                ? `${app.name} is being built`
                : comingSoon
                  ? `${app.name} is on the way`
                  : `${app.name} is not on your plan yet`}
            </h2>

            <p className="mx-auto mt-2.5 max-w-md text-base leading-relaxed text-[var(--text-secondary)]">
              {active
                ? `Your workspace already has ${app.name}. Its screens are next in the build queue — your data and permissions are ready for them.`
                : comingSoon
                  ? `We are still building ${app.name}. It will appear in the marketplace the moment it ships.`
                  : app.description}
            </p>

            {!active && !comingSoon && (
              <Can
                permission="catalog.apps.manage"
                fallback={
                  <p className="mt-6 flex items-center justify-center gap-1.5 text-sm text-[var(--text-tertiary)]">
                    <Lock className="size-3.5" />
                    Ask an owner or admin to add it.
                  </p>
                }
              >
                <div className="mt-7 flex flex-col items-center gap-3">
                  <p className="text-md font-semibold tabular">
                    {money(app.price.monthly, app.price.currency)}
                    <span className="text-xs font-normal text-[var(--text-tertiary)]">
                      {' '}per {app.price.per} / month
                    </span>
                  </p>
                  <Link href="/apps">
                    <Button variant="primary" size="lg" className="cta" icon={Store}>
                      Add {app.name}
                      <ArrowRight className="size-4" strokeWidth={2} />
                    </Button>
                  </Link>
                </div>
              </Can>
            )}

            {active && (
              <div className="mt-7 flex items-center justify-center gap-2">
                <Hammer className="size-4 text-[var(--text-tertiary)]" />
                <span className="text-sm text-[var(--text-tertiary)]">In active development</span>
              </div>
            )}
          </div>
        </div>

        {app.highlights?.length > 0 && (
          <div className="border-t border-[var(--border-subtle)] px-8 py-6">
            <p className="mb-3 text-sm font-medium text-[var(--text-secondary)]">What it will do</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {app.highlights.map((highlight) => (
                <li key={highlight} className="flex items-start gap-2 text-base text-[var(--text-secondary)]">
                  <Check className="mt-0.5 size-4 shrink-0 text-[var(--color-positive-500)]" strokeWidth={2.5} />
                  {highlight}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <p className="mt-5 text-center text-sm text-[var(--text-tertiary)]">
        Looking for something that works today?{' '}
        <Link href="/crm" className="font-medium text-[var(--text-brand)] hover:underline">
          CRM is live
        </Link>
        .
      </p>
    </div>
  );
}
