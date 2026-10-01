'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, Users, Shield, CreditCard, UserCircle, Bell, KeyRound, ScrollText, Mail } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/lib/workspace';

const SECTIONS = [
  {
    label: 'Account',
    items: [
      { href: '/settings/profile', label: 'Your profile', icon: UserCircle },
      { href: '/settings/security', label: 'Security & sessions', icon: KeyRound },
      { href: '/settings/notifications', label: 'Notifications', icon: Bell },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/settings/audit', label: 'Audit log', icon: ScrollText, permission: 'core.audit.view' },
      { href: '/settings/emails', label: 'Email log', icon: Mail, permission: 'core.settings.manage' },
      { href: '/settings/general', label: 'General', icon: Building2, permission: 'core.settings.view' },
      { href: '/settings/members', label: 'People', icon: Users, permission: 'core.members.view' },
      { href: '/settings/roles', label: 'Roles & permissions', icon: Shield, permission: 'core.roles.view' },
      { href: '/settings/billing', label: 'Plan & billing', icon: CreditCard, permission: 'billing.subscription.view' },
    ],
  },
];

export default function SettingsNav() {
  const pathname = usePathname();
  const { can } = useWorkspace();

  return (
    <nav className="w-full shrink-0 lg:w-56" aria-label="Settings">
      <h1 className="mb-4 text-lg font-semibold tracking-[-0.02em]">Settings</h1>

      <div className="space-y-5">
        {SECTIONS.map((section) => {
          const items = section.items.filter((item) => !item.permission || can(item.permission));
          if (!items.length) return null;

          return (
            <div key={section.label}>
              <p className="mb-1.5 px-2 text-2xs font-semibold uppercase tracking-wide text-[var(--text-disabled)]">
                {section.label}
              </p>
              <div className="space-y-px">
                {items.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-base transition-colors',
                        active
                          ? 'bg-[var(--surface-active)] font-medium text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      <item.icon className="size-4 shrink-0" strokeWidth={1.75} />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
