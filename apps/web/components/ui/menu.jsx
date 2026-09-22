'use client';

import { useEffect, useRef, useState, createContext, useContext, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

const MenuContext = createContext(null);

/**
 * A small, dependency-free dropdown. Positions against the trigger, traps
 * arrow-key navigation, closes on Escape / outside click, and returns focus.
 */
export function Menu({ trigger, children, align = 'start', width = 220, className }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const position = useCallback(() => {
    // The wrapper is `display: contents`, so it has no box of its own and
    // would measure as 0×0 at the origin. Measure the actual trigger element.
    const anchor = triggerRef.current?.firstElementChild ?? triggerRef.current;
    const rect = anchor?.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const gap = 6;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 260 && rect.top > spaceBelow;

    let left = align === 'end' ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

    setCoords({
      left,
      top: openUp ? undefined : rect.bottom + gap,
      bottom: openUp ? window.innerHeight - rect.top + gap : undefined,
    });
  }, [align, width]);

  useEffect(() => {
    if (!open) return undefined;
    position();

    const onKey = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...(menuRef.current?.querySelectorAll('[data-menu-item]:not([disabled])') ?? [])];
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        const next =
          event.key === 'ArrowDown'
            ? items[(index + 1) % items.length]
            : items[(index - 1 + items.length) % items.length];
        next?.focus();
      }
    };

    const onPointer = (event) => {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, position]);

  return (
    <MenuContext.Provider value={{ close: () => setOpen(false) }}>
      <span
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="contents"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
      </span>

      {open && coords && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', left: coords.left, top: coords.top, bottom: coords.bottom, width }}
            className={cn(
              'animate-pop z-50 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]',
              'bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-pop)]',
              className,
            )}
          >
            {children}
          </div>,
          document.body,
        )}
    </MenuContext.Provider>
  );
}

export function MenuItem({ icon: Icon, children, onClick, danger, selected, shortcut, disabled, href }) {
  const { close } = useContext(MenuContext) ?? {};
  const Tag = href ? 'a' : 'button';

  return (
    <Tag
      data-menu-item
      href={href}
      disabled={disabled}
      role="menuitem"
      onClick={(event) => {
        if (disabled) return;
        onClick?.(event);
        close?.();
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-base',
        'transition-colors duration-100 outline-none',
        'hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]',
        danger
          ? 'text-[var(--color-critical-600)] hover:bg-[var(--color-critical-50)] dark:hover:bg-[rgb(239_68_68/0.1)]'
          : 'text-[var(--text-primary)]',
        disabled && 'pointer-events-none opacity-45',
      )}
    >
      {Icon && <Icon className="size-4 shrink-0 text-[var(--text-tertiary)]" strokeWidth={1.75} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="text-2xs text-[var(--text-disabled)]">{shortcut}</span>}
      {selected && <Check className="size-4 shrink-0 text-[var(--text-brand)]" />}
    </Tag>
  );
}

export const MenuDivider = () => <div className="my-1 h-px bg-[var(--border-subtle)]" />;

export const MenuLabel = ({ children }) => (
  <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-[var(--text-disabled)]">
    {children}
  </div>
);
