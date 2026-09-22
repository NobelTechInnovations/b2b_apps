'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { APP_CATEGORIES, appsByCategory } from '@nexus/contracts';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Icon, tintFor } from '@/components/shell/icon';

/** The catalogue, browsable by category — the heart of the marketing site. */
export function AppUniverse() {
  const [active, setActive] = useState(APP_CATEGORIES[0].slug);
  const apps = appsByCategory(active);
  const category = APP_CATEGORIES.find((c) => c.slug === active);

  return (
    <section className="border-y border-[var(--border-subtle)] bg-[var(--surface-raised)]">
      <div className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
        <div className="text-center">
          <p className="text-sm font-semibold text-[var(--text-brand)]">The catalogue</p>
          <h2 className="mx-auto mt-2 max-w-2xl text-[32px] font-semibold leading-tight tracking-[-0.03em] lg:text-[40px]">
            Thirteen categories. One workspace.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-md text-[var(--text-secondary)]">
            Every app shares the same customers, products, people and documents.
            Switch one on and it is instantly connected to the rest.
          </p>
        </div>

        <div className="mt-10 flex flex-wrap justify-center gap-2">
          {APP_CATEGORIES.map((c) => (
            <button
              key={c.slug}
              onClick={() => setActive(c.slug)}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-sm font-medium transition-all duration-150',
                active === c.slug
                  ? 'bg-[var(--surface-inverse)] text-[var(--text-inverse)] shadow-sm'
                  : 'bg-[var(--surface-page)] text-[var(--text-secondary)] ring-1 ring-inset ring-[var(--border-subtle)] hover:text-[var(--text-primary)]',
              )}
            >
              {c.name}
            </button>
          ))}
        </div>

        <p className="mt-6 text-center text-sm text-[var(--text-tertiary)]">{category?.description}</p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <article key={app.slug} className="panel panel-hover flex flex-col p-5">
              <div className="flex items-start gap-3">
                <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]', tintFor(app.color))}>
                  <Icon name={app.icon} className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-md font-semibold">{app.name}</h3>
                    {app.status === 'coming_soon' && (
                      <span className="shrink-0 rounded-full bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
                        Soon
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{app.tagline}</p>
                </div>
              </div>

              <p className="mt-3.5 line-clamp-3 text-sm leading-relaxed text-[var(--text-secondary)]">
                {app.description}
              </p>

              <div className="mt-auto flex items-baseline justify-between pt-5">
                <p className="text-base font-semibold tabular">
                  {app.price.monthly === 0 ? 'Free' : money(app.price.monthly, app.price.currency)}
                  <span className="ml-1 text-2xs font-normal text-[var(--text-tertiary)]">
                    /{app.price.per}/mo
                  </span>
                </p>
                {app.dependencies?.length > 0 && (
                  <p className="text-2xs text-[var(--text-tertiary)]">
                    needs {app.dependencies.join(', ')}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>

        <div className="mt-10 text-center">
          <Link href="/apps-directory">
            <Button variant="secondary" size="lg" iconRight={ArrowRight}>See all apps</Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
