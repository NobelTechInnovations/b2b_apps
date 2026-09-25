'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell, CheckCheck, Clock3, CalendarOff, FileText, Target, ListChecks, Inbox,
} from 'lucide-react';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

const ICON = {
  'attendance.request': Clock3,
  'attendance.decided': Clock3,
  'leave.request': CalendarOff,
  'leave.decided': CalendarOff,
  'document.issued': FileText,
  'review.opened': Target,
  'review.shared': Target,
  'task.assigned': ListChecks,
  'task.completed': ListChecks,
};

/** How often the bell asks. Cheap: one indexed count. */
const POLL_MS = 30_000;

/**
 * The bell.
 *
 * Shows a count only when there is something unread — a permanent dot that
 * means nothing teaches people to ignore it. Polls quietly, pauses while the
 * tab is hidden, and refreshes the moment it is opened.
 */
export function NotificationBell({ className }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState(null);
  const panel = useRef(null);

  const refreshCount = useCallback(async ({ poll = false } = {}) => {
    // Background tabs skip the periodic check, but never the first one —
    // otherwise a page opened in a new tab shows no count until it is looked at.
    if (poll && typeof document !== 'undefined' && document.hidden) return;
    try {
      const response = await api.get('/notifications/unread-count', { redirectOnUnauthorized: false });
      setUnread(response.data?.unread ?? 0);
    } catch {
      // The bell is never worth an error message.
    }
  }, []);

  const loadItems = useCallback(async () => {
    try {
      const response = await api.get('/notifications', { query: { limit: 20 }, redirectOnUnauthorized: false });
      setItems(response.data ?? []);
      setUnread(response.meta?.unread ?? 0);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = setInterval(() => refreshCount({ poll: true }), POLL_MS);
    const onVisible = () => { if (!document.hidden) refreshCount(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [refreshCount]);

  useEffect(() => { if (open) loadItems(); }, [open, loadItems]);

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (panel.current && !panel.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function markRead(ids) {
    try {
      await api.post('/notifications/read', ids ? { ids } : { all: true });
      setItems((list) => list?.map((n) => (!ids || ids.includes(n.id) ? { ...n, read_at: new Date().toISOString() } : n)));
      setUnread((count) => (ids ? Math.max(0, count - ids.length) : 0));
    } catch { /* stays unread; harmless */ }
  }

  function follow(item) {
    if (!item.read_at) markRead([item.id]);
    setOpen(false);
    if (item.link) router.push(item.link);
  }

  return (
    <div ref={panel} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className="relative flex size-9 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      >
        <Bell className="size-[18px]" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-critical-500)] px-1 text-[10px] font-semibold leading-none text-white tabular">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-overlay)] shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markRead()}
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand-600)] hover:underline dark:text-[var(--color-brand-400)]"
              >
                <CheckCheck className="size-3.5" />Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[26rem] overflow-y-auto">
            {items === null ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 w-full" />)}
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-10 text-center">
                <Inbox className="size-6 text-[var(--text-tertiary)]" strokeWidth={1.5} />
                <p className="mt-2 text-sm font-medium">You are all caught up</p>
                <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                  Approvals, assignments and replies land here.
                </p>
              </div>
            ) : (
              items.map((item) => {
                const Icon = ICON[item.kind] ?? Bell;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => follow(item)}
                    className={cn(
                      'flex w-full gap-3 border-b border-[var(--border-subtle)] px-4 py-3 text-left transition-colors last:border-0 hover:bg-[var(--surface-hover)]',
                      !item.read_at && 'bg-[var(--color-brand-50)]/60 dark:bg-[rgb(99_102_241/0.06)]',
                    )}
                  >
                    <span className={cn(
                      'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                      item.read_at
                        ? 'bg-[var(--surface-sunken)] text-[var(--text-tertiary)]'
                        : 'bg-[var(--color-brand-100)] text-[var(--color-brand-700)] dark:bg-[rgb(99_102_241/0.18)] dark:text-[var(--color-brand-300)]',
                    )}>
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm leading-snug', !item.read_at && 'font-medium')}>
                        {item.title}
                      </span>
                      {item.body && (
                        <span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">{item.body}</span>
                      )}
                      <span className="mt-1 block text-2xs text-[var(--text-tertiary)]">
                        {relativeTime(item.created_at)}
                      </span>
                    </span>
                    {!item.read_at && <span className="mt-2 size-2 shrink-0 rounded-full bg-[var(--color-brand-500)]" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
