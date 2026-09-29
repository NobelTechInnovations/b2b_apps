'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

export function Modal({ open, onClose, title, description, children, footer, size = 'md', className }) {
  const panelRef = useRef(null);
  // Callers usually pass an inline `onClose`, which is a new function on every
  // render. Depending on it re-ran the effect below on each keystroke: its
  // cleanup handed focus back to the page and its setup re-focused the first
  // field, so typing into anything but the first input kept losing focus.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') closeRef.current?.();
      if (event.key !== 'Tab') return;

      // Keep focus inside the dialog while it is open.
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

    requestAnimationFrame(() => {
      panelRef.current?.querySelector('[data-autofocus]')?.focus() ??
        panelRef.current?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-2xl', full: 'max-w-4xl' };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]">
      <div
        className="animate-fade fixed inset-0 bg-[rgb(11_16_23/0.45)] backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'animate-pop relative w-full rounded-[var(--radius-2xl)] border border-[var(--border-subtle)]',
          'bg-[var(--surface-overlay)] shadow-[var(--shadow-xl)] outline-none',
          widths[size],
          className,
        )}
      >
        {(title || onClose) && (
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-1">
            <div className="min-w-0">
              {title && <h2 className="text-md font-semibold">{title}</h2>}
              {description && (
                <p className="mt-1 text-base text-[var(--text-secondary)]">{description}</p>
              )}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" className="-mr-1 -mt-1">
              <X className="size-4" />
            </Button>
          </div>
        )}

        <div className="px-5 py-4">{children}</div>

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

export function ConfirmModal({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', danger, loading }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <span className="sr-only">{description}</span>
    </Modal>
  );
}
