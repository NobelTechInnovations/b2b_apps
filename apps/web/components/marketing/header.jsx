'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Menu as MenuIcon, X, ArrowRight } from 'lucide-react';
import { APP_CATEGORIES, appsByCategory } from '@nexus/contracts';
import { cn } from '@/lib/cn';
import { Wordmark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Icon, tintFor } from '@/components/shell/icon';

const LINKS = [
  { label: 'Pricing', href: '/pricing' },
  { label: 'Customers', href: '/customers' },
  { label: 'Docs', href: '/docs' },
];

export function MarketingHeader({ signedIn, needsOnboarding }) {
  const [appsOpen, setAppsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && setAppsOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const workspaceHref = needsOnboarding ? '/onboarding' : '/dashboard';

  return (
    <header
      className={cn(
        'sticky top-0 z-40 transition-[background-color,box-shadow,backdrop-filter] duration-200',
        scrolled
          ? 'bg-[color-mix(in_srgb,var(--surface-raised)_82%,transparent)] shadow-[0_1px_0_0_var(--border-subtle)] backdrop-blur-xl'
          : 'bg-transparent',
      )}
      onMouseLeave={() => setAppsOpen(false)}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-5 lg:px-8">
        <Link href="/" className="rounded-[var(--radius-md)]">
          <Wordmark />
        </Link>

        <nav className="ml-8 hidden items-center gap-1 lg:flex">
          <button
            onMouseEnter={() => setAppsOpen(true)}
            onClick={() => setAppsOpen((v) => !v)}
            aria-expanded={appsOpen}
            className={cn(
              'flex items-center gap-1 rounded-[var(--radius-md)] px-3 py-1.5 text-base font-medium transition-colors',
              appsOpen
                ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            Apps
            <ChevronDown className={cn('size-3.5 transition-transform duration-200', appsOpen && 'rotate-180')} />
          </button>

          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-[var(--radius-md)] px-3 py-1.5 text-base font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex-1" />

        <div className="hidden items-center gap-2 lg:flex">
          {signedIn ? (
            <Link href={workspaceHref}>
              <Button variant="primary" size="sm" iconRight={ArrowRight}>Go to workspace</Button>
            </Link>
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost" size="sm">Sign in</Button>
              </Link>
              <Link href="/signup">
                <Button variant="primary" size="sm" iconRight={ArrowRight}>Start free</Button>
              </Link>
            </>
          )}
        </div>

        <button
          onClick={() => setMobileOpen((v) => !v)}
          className="rounded-[var(--radius-md)] p-2 text-[var(--text-secondary)] lg:hidden"
          aria-label="Menu"
        >
          {mobileOpen ? <X className="size-5" /> : <MenuIcon className="size-5" />}
        </button>
      </div>

      {appsOpen && <AppsMegaMenu onNavigate={() => setAppsOpen(false)} />}

      {mobileOpen && (
        <div className="animate-rise border-t border-[var(--border-subtle)] bg-[var(--surface-raised)] px-5 py-4 lg:hidden">
          <div className="space-y-1">
            <Link href="/apps-directory" className="block py-2 text-base font-medium">All apps</Link>
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="block py-2 text-base font-medium">{l.label}</Link>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            {signedIn ? (
              <Link href={workspaceHref} className="flex-1"><Button variant="primary" className="w-full">Go to workspace</Button></Link>
            ) : (
              <>
                <Link href="/login" className="flex-1"><Button variant="secondary" className="w-full">Sign in</Button></Link>
                <Link href="/signup" className="flex-1"><Button variant="primary" className="w-full">Start free</Button></Link>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

/** Odoo/Zoho-style mega menu: every category, every app, one glance. */
function AppsMegaMenu({ onNavigate }) {
  return (
    <div className="animate-pop absolute inset-x-0 top-16 hidden border-t border-[var(--border-subtle)] bg-[var(--surface-overlay)] shadow-[var(--shadow-xl)] lg:block">
      <div className="mx-auto max-w-6xl px-8 py-7">
        <div className="grid grid-cols-4 gap-x-8 gap-y-6">
          {APP_CATEGORIES.map((category) => {
            const apps = appsByCategory(category.slug);
            if (!apps.length) return null;

            return (
              <div key={category.slug}>
                <div className="mb-2 flex items-center gap-1.5">
                  <Icon name={category.icon} className="size-3.5 text-[var(--text-tertiary)]" strokeWidth={2} />
                  <p className="text-2xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                    {category.name}
                  </p>
                </div>
                <ul className="space-y-0.5">
                  {apps.map((app) => (
                    <li key={app.slug}>
                      <Link
                        href={`/apps-directory#${app.slug}`}
                        onClick={onNavigate}
                        className="group flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 transition-colors hover:bg-[var(--surface-hover)]"
                      >
                        <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-xs)]', tintFor(app.color))}>
                          <Icon name={app.icon} className="size-3" strokeWidth={2.25} />
                        </span>
                        <span className="truncate text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                          {app.name}
                        </span>
                        {app.status === 'coming_soon' && (
                          <span className="ml-auto shrink-0 text-[10px] text-[var(--text-disabled)]">soon</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="mt-7 flex items-center justify-between border-t border-[var(--border-subtle)] pt-5">
          <p className="text-sm text-[var(--text-secondary)]">
            One workspace, one sign-in, one bill — pick only what you need.
          </p>
          <Link href="/apps-directory" onClick={onNavigate}>
            <Button variant="secondary" size="sm" iconRight={ArrowRight}>Browse all apps</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
