'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, Check, ArrowRight, Link2 } from 'lucide-react';
import { APP_CATEGORIES, APPS, appsByCategory } from '@nexus/contracts';
import { cn } from '@/lib/cn';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon, tintFor } from '@/components/shell/icon';

export default function DirectoryClient({ total }) {
  const [query, setQuery] = useState('');

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return APP_CATEGORIES.map((category) => ({
      category,
      apps: appsByCategory(category.slug).filter((app) => {
        if (!needle) return true;
        return (
          app.name.toLowerCase().includes(needle) ||
          app.tagline?.toLowerCase().includes(needle) ||
          app.description?.toLowerCase().includes(needle) ||
          app.highlights?.some((h) => h.toLowerCase().includes(needle))
        );
      }),
    })).filter((section) => section.apps.length > 0);
  }, [query]);

  const matches = sections.reduce((sum, s) => sum + s.apps.length, 0);

  return (
    <>
      <section className="aurora relative border-b border-[var(--border-subtle)]">
        <div className="fine-grid pointer-events-none absolute inset-0" />
        <div className="relative mx-auto max-w-6xl px-5 py-16 text-center lg:px-8 lg:py-20">
          <h1 className="text-[36px] font-semibold leading-tight tracking-[-0.035em] lg:text-[48px]">
            <span className="gradient-text">{total} apps.</span> One workspace.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-md text-[var(--text-secondary)]">
            Every app shares the same customers, products, people and documents.
            Take what you need — the rest is one click away when you are ready.
          </p>

          <div className="mx-auto mt-8 max-w-md">
            <Input
              size="lg"
              icon={Search}
              placeholder="Search apps — try “invoice”, “stock”, “leave”…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <p className="mt-2 text-sm text-[var(--text-tertiary)]">
                {matches} {matches === 1 ? 'app matches' : 'apps match'} “{query}”
              </p>
            )}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
        {sections.length === 0 && (
          <div className="py-20 text-center">
            <p className="text-md font-medium">Nothing matches “{query}”</p>
            <p className="mt-1 text-base text-[var(--text-secondary)]">
              Try a broader word, or browse the categories below.
            </p>
            <Button variant="secondary" className="mt-5" onClick={() => setQuery('')}>
              Clear search
            </Button>
          </div>
        )}

        <div className="space-y-16">
          {sections.map(({ category, apps }) => (
            <section key={category.slug} id={category.slug} className="scroll-mt-24">
              <div className="flex items-end justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                    <Icon name={category.icon} className="size-4.5" />
                  </span>
                  <div>
                    <h2 className="text-lg font-semibold tracking-[-0.02em]">{category.name}</h2>
                    <p className="text-sm text-[var(--text-secondary)]">{category.description}</p>
                  </div>
                </div>
                <p className="hidden shrink-0 text-sm tabular text-[var(--text-tertiary)] sm:block">
                  {apps.length} {apps.length === 1 ? 'app' : 'apps'}
                </p>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {apps.map((app) => (
                  <article key={app.slug} id={app.slug} className="panel panel-hover scroll-mt-24 p-5">
                    <div className="flex items-start gap-3.5">
                      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-lg)]', tintFor(app.color))}>
                        <Icon name={app.icon} className="size-5" />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-md font-semibold">{app.name}</h3>
                          {app.flagship && (
                            <span className="rounded-full bg-[var(--color-brand-50)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-brand-700)] dark:bg-[rgb(99_102_241/0.14)] dark:text-[var(--color-brand-300)]">
                              Popular
                            </span>
                          )}
                          {app.status === 'coming_soon' && (
                            <span className="rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
                              Coming soon
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{app.tagline}</p>
                      </div>
                    </div>

                    <p className="mt-3.5 text-sm leading-relaxed text-[var(--text-secondary)]">
                      {app.description}
                    </p>

                    {app.highlights?.length > 0 && (
                      <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
                        {app.highlights.map((highlight) => (
                          <li key={highlight} className="flex items-start gap-1.5 text-sm text-[var(--text-secondary)]">
                            <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--color-positive-500)]" strokeWidth={3} />
                            <span className="min-w-0">{highlight}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {app.dependencies?.length > 0 && (
                      <p className="mt-4 flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                        <Link2 className="size-3.5 shrink-0" />
                        Works with {app.dependencies.map((d) => APPS.find((a) => a.slug === d)?.name ?? d).join(' and ')}
                      </p>
                    )}

                    <div className="mt-5 flex items-end justify-between gap-3 border-t border-[var(--border-subtle)] pt-4">
                      <div>
                        <p className="text-lg font-semibold tabular tracking-[-0.02em]">
                          {app.price.monthly === 0 ? 'Free' : money(app.price.monthly, app.price.currency)}
                        </p>
                        <p className="text-2xs text-[var(--text-tertiary)]">
                          per {app.price.per} / month
                        </p>
                      </div>
                      <Link href="/signup">
                        <Button
                          size="sm"
                          variant={app.status === 'coming_soon' ? 'ghost' : 'secondary'}
                          disabled={app.status === 'coming_soon'}
                          iconRight={app.status === 'coming_soon' ? undefined : ArrowRight}
                        >
                          {app.status === 'coming_soon' ? 'Coming soon' : 'Try free'}
                        </Button>
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
