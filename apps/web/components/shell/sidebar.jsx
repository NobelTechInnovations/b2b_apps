'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Store, Settings, ChevronDown, PanelLeftClose, PanelLeft, Plus,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/lib/workspace';
import { Icon, tintFor } from './icon';
import { Button } from '@/components/ui/button';

/**
 * The sidebar is generated entirely from the workspace payload: installed
 * apps, filtered by this user's permissions. Uninstall HR and HR disappears —
 * from the nav and, more importantly, from the backend.
 */
export function Sidebar({ collapsed, onToggle }) {
  const pathname = usePathname();
  const { navigation, loading } = useWorkspace();
  const [expanded, setExpanded] = useState({});

  // Keep the section you are inside open, without fighting manual toggles.
  useEffect(() => {
    const active = navigation.find((app) => pathname.startsWith(`/${app.slug}`));
    if (active) setExpanded((state) => ({ ...state, [active.slug]: state[active.slug] ?? true }));
  }, [pathname, navigation]);

  const isActive = (path) => pathname === path || pathname.startsWith(`${path}/`);

  return (
    <nav
      aria-label="Main"
      style={{ width: collapsed ? 'var(--nav-width-collapsed)' : 'var(--nav-width)' }}
      className={cn(
        'flex shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-raised)]',
        'transition-[width] duration-200 ease-[var(--ease-out-quint)]',
      )}
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3">
        <NavLink
          href="/dashboard"
          icon={LayoutDashboard}
          label="Dashboard"
          active={pathname === '/dashboard'}
          collapsed={collapsed}
        />

        <div className="my-3 h-px bg-[var(--border-subtle)]" />

        {loading && (
          <div className="space-y-2 px-1">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-7 w-full" />)}
          </div>
        )}

        {!loading && navigation.length === 0 && !collapsed && (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)] p-3 text-center">
            <p className="text-xs text-[var(--text-secondary)]">No apps yet.</p>
            <Link href="/apps">
              <Button variant="ghost" size="xs" icon={Plus} className="mt-2">Browse apps</Button>
            </Link>
          </div>
        )}

        <div className="space-y-0.5">
          {navigation.map((app) => {
            const open = expanded[app.slug] ?? false;
            const sectionActive = pathname.startsWith(`/${app.slug}`);

            if (collapsed) {
              return (
                <Link
                  key={app.slug}
                  href={app.items[0]?.path ?? `/${app.slug}`}
                  title={app.label}
                  className={cn(
                    'flex h-9 items-center justify-center rounded-[var(--radius-md)] transition-colors',
                    sectionActive ? tintFor(app.color) : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                  )}
                >
                  <Icon name={app.icon} className="size-[18px]" />
                </Link>
              );
            }

            return (
              <div key={app.slug}>
                <button
                  onClick={() => setExpanded((s) => ({ ...s, [app.slug]: !open }))}
                  aria-expanded={open}
                  className={cn(
                    'group flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5',
                    'text-left transition-colors duration-100',
                    sectionActive
                      ? 'text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-xs)]', tintFor(app.color))}>
                    <Icon name={app.icon} className="size-3.5" strokeWidth={2} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-base font-medium">{app.label}</span>
                  <ChevronDown
                    className={cn(
                      'size-3.5 shrink-0 text-[var(--text-disabled)] transition-transform duration-200',
                      open && 'rotate-180',
                    )}
                  />
                </button>

                {open && (
                  <div className="relative mt-0.5 space-y-px pb-1 pl-[18px]">
                    <span className="absolute bottom-2 left-[18px] top-0 w-px bg-[var(--border-subtle)]" />
                    {app.items.map((item) => (
                      <Link
                        key={item.path}
                        href={item.path}
                        className={cn(
                          'relative flex items-center gap-2 rounded-[var(--radius-sm)] py-1.5 pl-4 pr-2',
                          'text-sm transition-colors duration-100',
                          isActive(item.path)
                            ? 'bg-[var(--surface-active)] font-medium text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                        )}
                      >
                        {isActive(item.path) && (
                          <span className="absolute -left-px top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[var(--color-brand-500)]" />
                        )}
                        <span className="truncate">{item.label}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-[var(--border-subtle)] p-2.5">
        <NavLink href="/apps" icon={Store} label="Browse apps" active={pathname.startsWith('/apps')} collapsed={collapsed} />
        <NavLink href="/settings" icon={Settings} label="Settings" active={pathname.startsWith('/settings')} collapsed={collapsed} />

        <button
          onClick={onToggle}
          className={cn(
            'mt-1 flex h-8 w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2',
            'text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            collapsed && 'justify-center px-0',
          )}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeft className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
          {!collapsed && <span className="text-sm">Collapse</span>}
        </button>
      </div>
    </nav>
  );
}

function NavLink({ href, icon: IconComponent, label, active, collapsed }) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-[var(--radius-md)] px-2 transition-colors duration-100',
        collapsed && 'justify-center px-0',
        active
          ? 'bg-[var(--surface-active)] font-medium text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <IconComponent className="size-[18px] shrink-0" strokeWidth={1.75} />
      {!collapsed && <span className="truncate text-base">{label}</span>}
    </Link>
  );
}
