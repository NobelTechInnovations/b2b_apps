'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  LayoutDashboard, Clock, CalendarOff, Receipt, FileText, Target,
  LogOut, ChevronDown, Sun, Moon, Building2, Sparkles,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Avatar } from '@/components/ui/primitives';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { NotificationBell } from '@/components/shell/notification-bell';
import { apexUrl } from '@/lib/tenant';
import { AiHelpContext } from '@/lib/ai-help';
import { Assistant } from '@/components/ai/assistant';

const TABS = [
  { href: '/portal', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/portal/attendance', label: 'Attendance', icon: Clock },
  { href: '/portal/leave', label: 'Leave', icon: CalendarOff },
  { href: '/portal/payslips', label: 'Payslips', icon: Receipt },
  { href: '/portal/documents', label: 'Documents', icon: FileText },
  { href: '/portal/performance', label: 'Performance', icon: Target },
  { href: '/portal/ai', label: 'AI & agents', icon: Sparkles },
];

export function PortalShell({ user, organizations, children }) {
  const pathname = usePathname();
  const { organization, portalOnly, can, hasApp } = useWorkspace();
  const { theme, setTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  const orgName = organizations?.[0]?.name ?? organization?.name ?? 'Your workspace';

  async function signOut() {
    try { await api.post('/auth/logout', {}); } catch { /* leaving anyway */ }
    window.location.href = apexUrl('/login');
  }

  return (
    <AiHelpContext.Provider value={true}>
    <div className="min-h-screen bg-[var(--surface-page)]">
      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-brand-600)] text-white">
            <Building2 className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{orgName}</p>
            <p className="text-2xs text-[var(--text-tertiary)]">Employee portal</p>
          </div>

          <div className="flex-1" />

          {/* Owners and HR admins: the portal is their own record; HR admin is everyone's. */}
          {!portalOnly && hasApp('hr') && can('hr.employees.view') && (
            <Link href="/hr/employees" className="hidden rounded-[var(--radius-md)] border border-[var(--border-default)] px-2.5 py-1 text-sm font-medium transition-colors hover:bg-[var(--surface-hover)] sm:block">
              HR admin
            </Link>
          )}

          <NotificationBell />

          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="rounded-[var(--radius-md)] p-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            aria-label="Switch theme"
          >
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>

          <div className="relative">
            <button
              onClick={() => setMenuOpen((open) => !open)}
              className="flex items-center gap-2 rounded-[var(--radius-md)] py-1 pl-1 pr-2 transition-colors hover:bg-[var(--surface-hover)]"
            >
              <Avatar name={user?.name ?? user?.email} size="sm" />
              <span className="hidden max-w-[10rem] truncate text-sm font-medium sm:block">
                {user?.name ?? user?.email}
              </span>
              <ChevronDown className="size-3.5 text-[var(--text-tertiary)]" />
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] py-1 shadow-lg">
                  <div className="border-b border-[var(--border-subtle)] px-3 py-2">
                    <p className="truncate text-sm font-medium">{user?.name}</p>
                    <p className="truncate text-xs text-[var(--text-tertiary)]">{user?.email}</p>
                  </div>
                  {/* Somebody who also works here gets a way back to the app. */}
                  {!portalOnly && (
                    <Link
                      href="/dashboard"
                      className="flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <LayoutDashboard className="size-4 text-[var(--text-tertiary)]" />
                      Go to the workspace
                    </Link>
                  )}
                  <button
                    onClick={signOut}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    <LogOut className="size-4 text-[var(--text-tertiary)]" />
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <nav className="mx-auto max-w-5xl overflow-x-auto px-4 sm:px-6">
          <div className="flex gap-0.5">
            {TABS.map((tab) => {
              const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={cn(
                    'relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors',
                    active
                      ? 'text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <tab.icon className="size-4" />
                  {tab.label}
                  {active && (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--color-brand-500)]" />
                  )}
                </Link>
              );
            })}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">{children}</main>
      <Assistant />
    </div>
    </AiHelpContext.Provider>
  );
}
