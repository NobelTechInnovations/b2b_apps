'use client';

import { useState } from 'react';
import { NotificationBell } from './notification-bell';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Search, ChevronsUpDown, Check, Plus, LogOut, User, Settings,
  Sun, Moon, Monitor, CreditCard, LifeBuoy, Building2,
  IdCard, KeyRound,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Kbd } from '@/components/ui/primitives';
import { Menu, MenuItem, MenuDivider, MenuLabel } from '@/components/ui/menu';
import { apexUrl, tenantUrl } from '@/lib/tenant';
import { RequestAccessModal } from './request-access';

export function Topbar({ organizations = [], onOpenSearch }) {
  const router = useRouter();
  const { user, workspace, subscription } = useWorkspace();
  const { theme, setTheme } = useTheme();
  const [asking, setAsking] = useState(false);

  const current = organizations.find((o) => o.id === workspace?.organization?.id) ?? organizations[0];

  async function switchOrg(orgId) {
    if (orgId === current?.id) return;
    await api.post('/auth/switch-org', { org_id: orgId });
    // Each company lives at its own address; go there.
    window.location.href = tenantUrl(organizations.find((o) => o.id === orgId)?.slug, '/dashboard');
  }

  async function signOut() {
    await api.post('/auth/logout').catch(() => {});
    window.location.href = apexUrl('/login');
  }

  const trialDaysLeft =
    subscription?.status === 'trialing' && subscription?.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(subscription.trial_ends_at) - Date.now()) / 86_400_000))
      : null;

  return (
    <header
      style={{ height: 'var(--topbar-height)' }}
      className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3"
    >
      {/* ── workspace switcher ─────────────────────────────────────────────── */}
      <Menu
        align="start"
        width={264}
        trigger={
          <button data-tour="workspace-switcher" className="flex h-8 max-w-[220px] items-center gap-2 rounded-[var(--radius-md)] px-2 transition-colors hover:bg-[var(--surface-hover)]">
            <Avatar name={current?.name ?? 'Workspace'} src={current?.logo_url} size="sm" square />
            <span className="min-w-0 flex-1 truncate text-base font-medium">
              {current?.name ?? 'Workspace'}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-[var(--text-disabled)]" />
          </button>
        }
      >
        <MenuLabel>Workspaces</MenuLabel>
        {organizations.map((org) => (
          <MenuItem key={org.id} onClick={() => switchOrg(org.id)} selected={org.id === current?.id}>
            <span className="flex items-center gap-2">
              <Avatar name={org.name} src={org.logo_url} size="xs" square />
              <span className="truncate">{org.name}</span>
            </span>
          </MenuItem>
        ))}
        <MenuDivider />
        <MenuItem icon={Plus} onClick={() => router.push('/onboarding?new=1')}>
          Create a workspace
        </MenuItem>
        <MenuItem icon={Building2} onClick={() => router.push('/settings/general')}>
          Workspace settings
        </MenuItem>
      </Menu>

      {/* ── search ─────────────────────────────────────────────────────────── */}
      <button
        data-tour="search"
        onClick={onOpenSearch}
        className={cn(
          'ml-1 flex h-8 flex-1 max-w-md items-center gap-2 rounded-[var(--radius-md)] px-2.5',
          'border border-[var(--border-subtle)] bg-[var(--surface-page)] text-left',
          'text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-default)]',
        )}
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 truncate text-sm">Search or jump to…</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div className="flex-1" />

      {trialDaysLeft !== null && (
        <Link href="/settings/billing" className="hidden shrink-0 whitespace-nowrap sm:block">
          <Badge tone={trialDaysLeft <= 3 ? 'caution' : 'brand'} dot className="whitespace-nowrap">
            {trialDaysLeft === 0 ? 'Trial ended' : `${trialDaysLeft} days left in trial`}
          </Badge>
        </Link>
      )}

      <NotificationBell />

      {/* ── account ────────────────────────────────────────────────────────── */}
      <Menu
        align="end"
        width={248}
        trigger={
          <button className="rounded-full transition-opacity hover:opacity-85" aria-label="Account menu">
            <Avatar name={user?.name} src={user?.avatar_url} size="md" />
          </button>
        }
      >
        <div className="px-2 pb-2 pt-1.5">
          <p className="truncate text-base font-medium">{user?.name}</p>
          <p className="truncate text-xs text-[var(--text-tertiary)]">{user?.email}</p>
          {workspace?.member?.roles?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {workspace.member.roles.map((role) => (
                <Badge key={role} size="sm" tone={role === 'owner' ? 'brand' : 'neutral'}>
                  {role}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <MenuDivider />
        <MenuItem icon={User} onClick={() => router.push('/settings/profile')}>Your profile</MenuItem>
        <MenuItem icon={Settings} onClick={() => router.push('/settings')}>Settings</MenuItem>
        <MenuItem icon={CreditCard} onClick={() => router.push('/settings/billing')}>Plan & billing</MenuItem>
        {/* Your own payslips, leave and attendance, when the workspace runs HR. */}
        {workspace?.self_service && (
          <MenuItem icon={IdCard} onClick={() => router.push('/portal')}>My employee portal</MenuItem>
        )}
        {!workspace?.member?.is_owner && (
          <MenuItem icon={KeyRound} onClick={() => setAsking(true)}>Request access</MenuItem>
        )}
        <MenuDivider />
        <MenuLabel>Appearance</MenuLabel>
        <MenuItem icon={Sun} selected={theme === 'light'} onClick={() => setTheme('light')}>Light</MenuItem>
        <MenuItem icon={Moon} selected={theme === 'dark'} onClick={() => setTheme('dark')}>Dark</MenuItem>
        <MenuItem icon={Monitor} selected={theme === 'system'} onClick={() => setTheme('system')}>System</MenuItem>
        <MenuDivider />
        <MenuItem icon={LifeBuoy} href="/help">Help & support</MenuItem>
        <MenuItem icon={LogOut} danger onClick={signOut}>Sign out</MenuItem>
      </Menu>
      <RequestAccessModal open={asking} onClose={() => setAsking(false)} />
    </header>
  );
}
