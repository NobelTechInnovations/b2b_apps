'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { appBySlug } from '@nexus/contracts';
import { WorkspaceProvider } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Card, EmptyState } from '@/components/ui/primitives';
import { RequestAccessModal } from './request-access';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { CommandPalette } from './command-palette';

const COLLAPSE_KEY = 'nexus-sidebar-collapsed';

export function AppShell({ workspace, organizations, children }) {
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  const toggle = () => {
    setCollapsed((value) => {
      localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1');
      return !value;
    });
  };

  // ⌘K / Ctrl+K anywhere, except while typing into a field.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === '/' && !/^(INPUT|TEXTAREA)$/.test(event.target.tagName) && !event.target.isContentEditable) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <WorkspaceProvider initial={workspace}>
      <div className="flex h-screen overflow-hidden bg-[var(--surface-page)]">
        <Sidebar collapsed={collapsed} onToggle={toggle} />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar organizations={organizations} onOpenSearch={() => setPaletteOpen(true)} />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1400px] px-6 py-6 lg:px-8">
              <AppAccessGuard workspace={workspace}>{children}</AppAccessGuard>
            </div>
          </main>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WorkspaceProvider>
  );
}

/**
 * The workspace has the app, but this person was not given it. The gateway
 * refuses their requests either way; this says why instead of showing a
 * screen full of errors.
 */
function AppAccessGuard({ workspace, children }) {
  const pathname = usePathname();
  const [asking, setAsking] = useState(false);
  const app = appBySlug(pathname?.split('/')[1]);
  const blocked = app && !app.core
    && (workspace?.workspace_apps ?? []).includes(app.slug)
    && !(workspace?.apps ?? []).includes(app.slug);
  if (!blocked) return children;
  return (
    <Card className="mx-auto mt-10 max-w-lg">
      <EmptyState
        icon={Lock}
        title={`You don't have access to ${app.name}`}
        description="Your workspace uses this app, but it hasn't been shared with you. Ask for it and an owner or admin gets a notification."
        action={
          <div className="flex justify-center gap-2">
            <Button variant="primary" onClick={() => setAsking(true)}>Request access</Button>
            <Link href="/dashboard"><Button variant="secondary">Back to dashboard</Button></Link>
          </div>
        }
      />
      <RequestAccessModal open={asking} onClose={() => setAsking(false)} appSlug={app.slug} />
    </Card>
  );
}
