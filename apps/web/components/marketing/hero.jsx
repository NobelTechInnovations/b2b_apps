import Link from 'next/link';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { flagshipApps } from '@nexus/contracts';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/shell/icon';
import { tintFor } from '@/lib/app-theme';

const PROMISES = ['No credit card', '14-day free trial', 'Cancel anytime'];

export function Hero({ liveApps }) {
  const flagships = flagshipApps().slice(0, 8);

  return (
    <section className="aurora relative">
      <div className="fine-grid pointer-events-none absolute inset-0" />

      <div className="relative mx-auto max-w-6xl px-5 pb-20 pt-16 text-center lg:px-8 lg:pb-28 lg:pt-24">
        <Link
          href="/changelog"
          className="inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-raised)] py-1 pl-1 pr-3 text-xs shadow-xs transition-colors hover:border-[var(--color-brand-300)]"
        >
          <span className="rounded-full bg-[var(--color-brand-600)] px-2 py-0.5 text-2xs font-semibold text-white">
            New
          </span>
          <span className="text-[var(--text-secondary)]">
            {liveApps} apps now live — Commerce, Legal and Security just shipped
          </span>
          <ArrowRight className="size-3 text-[var(--text-tertiary)]" />
        </Link>

        <h1 className="mx-auto mt-7 max-w-3xl text-[40px] font-semibold leading-[1.08] tracking-[-0.035em] sm:text-[56px] lg:text-[64px]">
          <span className="gradient-text">Run your whole business</span>
          <br />
          on the apps you actually need
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-md leading-relaxed text-[var(--text-secondary)] lg:text-lg">
          CRM, HR, inventory, invoicing, accounting, helpdesk and more — on one
          workspace, with one login and one bill. Start with a single app and
          switch on the rest whenever you are ready.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/signup">
            <Button size="xl" className="cta w-full sm:w-auto">
              Start free
              <ArrowRight className="size-4" strokeWidth={2} />
            </Button>
          </Link>
          <Link href="/apps-directory">
            <Button size="xl" variant="secondary" className="w-full sm:w-auto">
              Explore the apps
            </Button>
          </Link>
        </div>

        <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {PROMISES.map((promise) => (
            <li key={promise} className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
              <Check className="size-3.5 text-[var(--color-positive-500)]" strokeWidth={3} />
              {promise}
            </li>
          ))}
        </ul>

        {/* ── the product, shown rather than described ───────────────────── */}
        <div className="relative mx-auto mt-16 max-w-4xl">
          <div className="absolute -inset-x-16 -top-8 bottom-0 bg-[radial-gradient(ellipse_at_center,rgb(99_102_241/0.12),transparent_70%)]" />
          <WorkspacePreview flagships={flagships} />
        </div>
      </div>
    </section>
  );
}

/** A faithful, static miniature of the real product shell. */
function WorkspacePreview({ flagships }) {
  return (
    <div className="panel sheen relative overflow-hidden p-1.5 shadow-[var(--shadow-xl)]">
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-page)]">
        {/* chrome */}
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2.5">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </div>
          <div className="mx-auto flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-page)] px-3 py-1 text-2xs text-[var(--text-tertiary)]">
            meridian.nexus.app
          </div>
        </div>

        <div className="flex text-left">
          {/* sidebar */}
          <div className="hidden w-44 shrink-0 space-y-0.5 border-r border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2.5 sm:block">
            <div className="mb-2 flex items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1">
              <span className="flex size-5 items-center justify-center rounded-[var(--radius-xs)] bg-[var(--color-brand-600)] text-[9px] font-bold text-white">
                MM
              </span>
              <span className="truncate text-2xs font-medium">Meridian</span>
            </div>
            {flagships.slice(0, 6).map((app) => (
              <div key={app.slug} className="flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1.5">
                <span className={cn('flex size-4 items-center justify-center rounded-[3px]', tintFor(app.color))}>
                  <Icon name={app.icon} className="size-2.5" strokeWidth={2.5} />
                </span>
                <span className="truncate text-2xs text-[var(--text-secondary)]">{app.name}</span>
              </div>
            ))}
          </div>

          {/* canvas */}
          <div className="min-w-0 flex-1 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="h-2.5 w-36 rounded-full bg-[var(--surface-active)]" />
                <div className="mt-1.5 h-2 w-52 rounded-full bg-[var(--surface-sunken)]" />
              </div>
              <div className="h-6 w-20 rounded-[var(--radius-sm)] bg-[var(--color-brand-600)] opacity-90" />
            </div>

            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Pipeline', value: '₹48.2L', tone: 'text-[var(--color-brand-600)]' },
                { label: 'Invoiced', value: '₹12.6L', tone: 'text-[var(--color-positive-600)]' },
                { label: 'Headcount', value: '128', tone: 'text-[var(--text-primary)]' },
                { label: 'Tickets', value: '14', tone: 'text-[var(--color-caution-600)]' },
              ].map((stat) => (
                <div key={stat.label} className="panel p-2.5">
                  <p className="text-[9px] text-[var(--text-tertiary)]">{stat.label}</p>
                  <p className={cn('mt-1 text-sm font-semibold tabular', stat.tone)}>{stat.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2">
              <div className="panel col-span-2 p-3">
                <div className="h-2 w-24 rounded-full bg-[var(--surface-active)]" />
                <div className="mt-3 flex h-20 items-end gap-1.5">
                  {[38, 55, 42, 68, 51, 78, 62, 88, 71, 95].map((h, i) => (
                    <div
                      key={i}
                      style={{ height: `${h}%` }}
                      className="flex-1 rounded-t-[3px] bg-gradient-to-t from-[var(--color-brand-600)] to-[var(--color-brand-400)] opacity-85"
                    />
                  ))}
                </div>
              </div>
              <div className="panel space-y-2 p-3">
                <div className="h-2 w-16 rounded-full bg-[var(--surface-active)]" />
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="size-4 rounded-full bg-[var(--surface-sunken)]" />
                    <span className="h-1.5 flex-1 rounded-full bg-[var(--surface-sunken)]" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
