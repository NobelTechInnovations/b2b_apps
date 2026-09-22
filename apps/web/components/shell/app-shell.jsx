'use client';

import { useEffect, useState } from 'react';
import { WorkspaceProvider } from '@/lib/workspace';
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
            <div className="mx-auto max-w-[1400px] px-6 py-6 lg:px-8">{children}</div>
          </main>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WorkspaceProvider>
  );
}
