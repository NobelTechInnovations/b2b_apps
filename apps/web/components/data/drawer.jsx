'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/**
 * A slide-over record panel. Records open beside the list rather than
 * navigating away, so context is never lost mid-task — the interaction Odoo
 * and Zoho both rely on for detail views.
 */
export function Drawer({ open, onClose, title, subtitle, badge, footer, width = 'md', children }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
      if (event.key !== 'Tab') return;

      const focusables = panelRef.current?.querySelectorAll(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      );
      if (!focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="animate-fade absolute inset-0 bg-[rgb(11_16_23/0.4)] backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ animation: 'slide-in 0.26s var(--ease-out-quint) both' }}
        className={cn(
          'relative flex h-full w-full flex-col border-l border-[var(--border-subtle)]',
          'bg-[var(--surface-raised)] shadow-[var(--shadow-xl)] outline-none',
          widths[width],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-md font-semibold">{title}</h2>
              {badge}
            </div>
            {subtitle && (
              <p className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">{subtitle}</p>
            )}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" className="-mr-1">
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Label/value pairs used throughout record panels. */
export function DetailGrid({ items, columns = 2, className }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3.5', columns === 2 && 'sm:grid-cols-2', className)}>
      {items.filter((item) => item.value !== undefined && item.value !== null && item.value !== '').map((item) => (
        <div key={item.label} className={item.full ? 'sm:col-span-2' : undefined}>
          <dt className="text-xs text-[var(--text-tertiary)]">{item.label}</dt>
          <dd className="mt-0.5 text-base text-[var(--text-primary)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
