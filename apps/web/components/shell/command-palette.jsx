'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Search, CornerDownLeft, ArrowUp, ArrowDown, Store, Settings, LayoutDashboard } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/lib/workspace';
import { Icon, tintFor } from './icon';
import { Kbd } from '@/components/ui/primitives';

/**
 * ⌘K. Every destination the current user actually has — derived from the same
 * workspace payload as the sidebar, so it can never offer a page the backend
 * would refuse.
 */
export function CommandPalette({ open, onClose }) {
  const router = useRouter();
  const { navigation } = useWorkspace();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef(null);

  const commands = useMemo(() => {
    const items = [
      { id: 'dashboard', label: 'Dashboard', group: 'Go to', path: '/dashboard', lucide: LayoutDashboard },
      { id: 'apps', label: 'Browse apps', group: 'Go to', path: '/apps', lucide: Store },
      { id: 'settings', label: 'Settings', group: 'Go to', path: '/settings', lucide: Settings },
    ];

    for (const app of navigation) {
      for (const item of app.items) {
        items.push({
          id: item.path,
          label: item.label,
          group: app.label,
          path: item.path,
          icon: app.icon,
          color: app.color,
        });
      }
    }
    return items;
  }, [navigation]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands.slice(0, 12);

    return commands
      .map((command) => {
        const label = command.label.toLowerCase();
        const group = command.group.toLowerCase();
        // Rank exact prefix matches above substring matches above group hits.
        const score =
          label.startsWith(needle) ? 0
          : label.includes(needle) ? 1
          : group.includes(needle) ? 2
          : -1;
        return { command, score };
      })
      .filter((r) => r.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map((r) => r.command);
  }, [query, commands]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      }
      if (event.key === 'Enter' && results[cursor]) {
        event.preventDefault();
        router.push(results[cursor].path);
        onClose();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, results, cursor, router, onClose]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open || typeof document === 'undefined') return null;

  let lastGroup = null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh]">
      <div className="animate-fade fixed inset-0 bg-[rgb(11_16_23/0.45)] backdrop-blur-[2px]" onClick={onClose} />

      <div className="animate-pop relative w-full max-w-lg overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border-subtle)] bg-[var(--surface-overlay)] shadow-[var(--shadow-xl)]">
        <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4">
          <Search className="size-4 shrink-0 text-[var(--text-tertiary)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps, pages and records…"
            className="h-12 flex-1 bg-transparent text-md outline-none placeholder:text-[var(--text-disabled)]"
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 && (
            <p className="px-3 py-8 text-center text-base text-[var(--text-tertiary)]">
              Nothing matches “{query}”.
            </p>
          )}

          {results.map((command, index) => {
            const showGroup = command.group !== lastGroup;
            lastGroup = command.group;
            const LucideIcon = command.lucide;

            return (
              <div key={command.id}>
                {showGroup && (
                  <div className="px-2.5 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wide text-[var(--text-disabled)]">
                    {command.group}
                  </div>
                )}
                <button
                  data-active={index === cursor}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => {
                    router.push(command.path);
                    onClose();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-left',
                    index === cursor ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-hover)]',
                  )}
                >
                  <span className={cn('flex size-5 items-center justify-center rounded-[var(--radius-xs)]', command.color ? tintFor(command.color) : 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]')}>
                    {LucideIcon ? <LucideIcon className="size-3.5" strokeWidth={2} /> : <Icon name={command.icon} className="size-3.5" strokeWidth={2} />}
                  </span>
                  <span className="flex-1 truncate text-base">{command.label}</span>
                  {index === cursor && <CornerDownLeft className="size-3.5 text-[var(--text-disabled)]" />}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-[var(--border-subtle)] px-4 py-2 text-2xs text-[var(--text-tertiary)]">
          <span className="flex items-center gap-1"><ArrowUp className="size-3" /><ArrowDown className="size-3" /> navigate</span>
          <span className="flex items-center gap-1"><CornerDownLeft className="size-3" /> open</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
